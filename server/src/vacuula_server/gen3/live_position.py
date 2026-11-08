"""Live position of a gen3 robot while it cleans, read from its black box log.

The robot writes its position every 100 ms into the black box (see gen3/blackbox.py) once e.MMC logging
is on. A read-only script on the robot (installer: bbtail.sh behind inetd, port VACUULA_BB_PORT) hands
out the newest log file from a byte offset. While the robot is busy this module asks it once a second
for the new bytes, decodes the newest position and sends it to the app as event "livePosition".

Positions are in the robot's own unit with the start of the run as origin and the axes of the map
(y up). Where that origin lies on the map is learnt per map: after a run that started on the dock, its
positions are matched against the run's RunMap track (calibrate()). Until a map is calibrated nothing
is sent for it.
"""
from __future__ import annotations

import json
import logging
import math
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from vacuula_server.constants import DATA_DIR, MAPS_DIR
from vacuula_server.env import BB_KEY, BB_PORT
from vacuula_server.gen3 import blackbox
from vacuula_server.state import push_to_app, robot_connections

logger = logging.getLogger(__name__)

STATE_BUSY = 2
POLL_S = 1.0
FETCH_TIMEOUT_S = 15       # the robot answers in 0.3 s at rest; while cleaning it is busier
IDLE_STOP_S = 20            # keep reading this long after the robot left BUSY (last blocks)
MAX_BUFFER = 1 << 20        # raw bytes kept while waiting for a whole block
CATCH_UP = 256 * 1024       # joining a run late: start this far before the end of the file
UNITS_PER_CELL = 445_400    # D7: robot units per map cell, fitted on two runs together (2026-11-08)
SESSION_KEEP_S = 15 * 60    # a run's positions wait this long for its map upload
CALIBRATION_FILE = DATA_DIR / "live_position.json"

MAP_ID_RE = re.compile(rb"Using Map ID (\S+) to begin persistent cleaning")


@dataclass
class Session:
    docked_at_start: bool
    map_id: str | None = None
    positions: list[tuple[float, float]] = field(default_factory=list)
    ended_at: float | None = None


@dataclass
class Reader:
    serial: str
    host: str
    name: str | None = None
    offset: int | None = None
    buf: bytes = b""
    stream: blackbox.PacketStream = field(default_factory=blackbox.PacketStream)
    idle_since: float | None = None
    stop: threading.Event = field(default_factory=threading.Event)
    reads: int = 0          # answers from the robot this run
    failed: int = 0         # requests without an answer
    slowest: float = 0.0    # longest answer, seconds
    failing: bool = False


_lock = threading.Lock()
_readers: dict[str, Reader] = {}
_sessions: dict[str, Session] = {}
_last_docked: dict[str, bool] = {}


# ---- robot state ------------------------------------------------------------------------------------
def on_state(serial: str, state: dict) -> None:
    if not BB_KEY:
        return
    busy = state.get("state") == STATE_BUSY
    with _lock:
        reader = _readers.get(serial)
        if not busy:
            _last_docked[serial] = bool((state.get("details") or {}).get("isDocked"))
            if reader and reader.idle_since is None:
                reader.idle_since = time.time()
            return
        if reader:
            reader.idle_since = None
            return
        conn = robot_connections.get(serial)
        host = getattr(conn, "host", None) if conn else None
        if not host:
            return
        _sessions[serial] = Session(docked_at_start=_last_docked.get(serial, False))
        reader = _readers[serial] = Reader(serial, host)
    threading.Thread(target=_run, args=(reader,), name=f"live-position-{serial}", daemon=True).start()


def _run(reader: Reader) -> None:
    logger.info("Live position of %s: reading the black box from %s:%d", reader.serial, reader.host, BB_PORT)
    try:
        while not reader.stop.is_set():
            if reader.idle_since and time.time() - reader.idle_since > IDLE_STOP_S:
                break
            started = time.time()
            try:
                _poll(reader)
                reader.reads += 1
                reader.slowest = max(reader.slowest, time.time() - started)
                if reader.failing:
                    reader.failing = False
                    logger.info("Live position of %s: black box readable again (after %.1f s)",
                                reader.serial, time.time() - started)
            except OSError as e:
                reader.failed += 1
                if not reader.failing:
                    reader.failing = True
                    logger.warning("Live position of %s: black box not readable (%s after %.1f s)",
                                   reader.serial, e, time.time() - started)
            reader.stop.wait(POLL_S)
    finally:
        with _lock:
            _readers.pop(reader.serial, None)
            if session := _sessions.get(reader.serial):
                session.ended_at = time.time()
                logger.info("Live position of %s: run ended, %d positions (map %s); %d reads, %d failed, slowest %.1f s",
                            reader.serial, len(session.positions), session.map_id, reader.reads, reader.failed,
                            reader.slowest)


def _poll(reader: Reader) -> None:
    if reader.name is None or reader.offset is None:
        # first contact: join the newest file near its end (a run that just started: from its start)
        (_, size, _, newest), _ = _fetch(reader.host, "-", 0)
        reader.name, reader.offset, reader.buf = newest, max(0, size - CATCH_UP), b""
        reader.stream = blackbox.PacketStream()
        return
    (name, size, start, newest), data = _fetch(reader.host, reader.name, reader.offset)
    if name != reader.name:  # our file is gone (the robot deleted it): start over on the newest
        reader.name = reader.offset = None
        return
    skip = reader.offset - start
    if 0 <= skip <= len(data):
        data = data[skip:]
        reader.offset += len(data)
        reader.buf = (reader.buf + data)[-MAX_BUFFER:]
    if reader.offset >= size and newest != reader.name:  # finished: the robot writes a new file now
        reader.name, reader.offset = newest, 0
        reader.stream = blackbox.PacketStream()
    blocks, used = blackbox.split_blocks(reader.buf)
    reader.buf = reader.buf[used:]
    latest = None
    session = _sessions.get(reader.serial)
    for block in blocks:
        try:
            payload = blackbox.block_payload(block, BB_KEY)
        except Exception as e:  # a damaged block costs only itself
            logger.debug("Live position of %s: block not readable: %s", reader.serial, e)
            continue
        for ptype, _clock, pdata in reader.stream.feed(payload):
            if ptype == blackbox.PKT_COORDS:
                latest = blackbox.Coords.parse(pdata)
                if session:
                    session.positions.append((latest.x, latest.y))
            elif ptype == blackbox.PKT_TEXT and session and (m := MAP_ID_RE.search(pdata)):
                session.map_id = m.group(1).decode(errors="replace")
    if latest and session:
        _send(reader.serial, session, latest)


def _fetch(host: str, name: str, offset: int) -> tuple[tuple[str, int, int, str], bytes]:
    """Ask bbtail.sh on the robot for `name` from `offset`. Its answer: a line
    "<name> <size> <start> <newest>", then the file's bytes from `start` (offset rounded down to 4 KiB)."""
    with socket.create_connection((host, BB_PORT), timeout=FETCH_TIMEOUT_S) as sock:
        sock.sendall(f"{name} {offset}\n".encode())
        chunks = []
        while chunk := sock.recv(65536):
            chunks.append(chunk)
    raw = b"".join(chunks)
    line, _, data = raw.partition(b"\n")
    parts = line.decode(errors="replace").split()
    if len(parts) != 4 or parts[0] == "-":
        raise OSError(f"unexpected answer {line[:80]!r}")
    return (parts[0], int(parts[1]), int(parts[2]), parts[3]), data


# ---- to the app -------------------------------------------------------------------------------------
def _send(serial: str, session: Session, pos: blackbox.Coords) -> None:
    cal = _calibration(serial, session.map_id) if session.docked_at_start and session.map_id else None
    if not cal:
        return
    push_to_app(serial, "livePosition", {
        "mapId": session.map_id,
        # map cells; the map image has y down
        "u": cal["u0"] + pos.x / cal["upc"],
        "v": cal["v0"] - pos.y / cal["upc"],
        "heading": -math.degrees(pos.heading),
        "t": time.time(),
    })


# ---- calibration ------------------------------------------------------------------------------------
def _load() -> dict:
    try:
        return json.loads(CALIBRATION_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _calibration(serial: str, map_id: str) -> dict | None:
    return _load().get(serial, {}).get(map_id)


def run_uploaded(serial: str, run: dict, job_folder: str) -> None:
    """A run's maps arrived: if this run's positions are at hand and it started on the dock, learn where
    the robot's origin lies on its map from the RunMap track."""
    with _lock:
        session = _sessions.get(serial)
        positions = list(session.positions) if session else []
    # the robot uploads its maps right at the end, while this server still reads its last blocks: a run
    # still being read counts, an older one only for SESSION_KEEP_S
    if not session or (session.ended_at and time.time() - session.ended_at > SESSION_KEEP_S):
        return
    map_id = run.get("persistent_map_id")
    why_not = ("no map id in the run" if not map_id
               else "it did not start on the dock" if not session.docked_at_start
               else f"only {len(positions)} positions" if len(positions) < 100
               else None)
    if why_not:
        logger.info("Live position of %s: run %s not used for calibration: %s", serial, run.get("id"), why_not)
        return
    try:
        result = calibrate(Path(job_folder), MAPS_DIR / serial / map_id, positions)
    except Exception as e:
        logger.warning("Live position of %s: calibration on run %s failed: %s", serial, run.get("id"), e)
        return
    if result is None:
        logger.info("Live position of %s: run %s not used for calibration: its track does not fit map %s "
                    "(other grid, or too far off)", serial, run.get("id"), map_id)
        return
    data = _load()
    data.setdefault(serial, {})[map_id] = result
    CALIBRATION_FILE.write_text(json.dumps(data, indent=1))
    logger.info("Live position of %s: map %s calibrated on run %s: %s", serial, map_id, run.get("id"), result)


def _grid(meta: dict) -> np.ndarray:
    """A map json's RLE as a (height, width) array."""
    flat = np.concatenate([np.full(n, v, dtype=np.uint8) for v, n in meta["rle"]])
    return flat.reshape(meta["height"], meta["width"])


def _distance_map(mask: np.ndarray) -> np.ndarray:
    """Distance in cells to the nearest True cell (two-pass chamfer, 1 and sqrt 2)."""
    h, w = mask.shape
    big = float(h + w)
    d = np.where(mask, 0.0, big)
    for y in range(h):
        for x in range(w):
            if y:
                d[y, x] = min(d[y, x], d[y - 1, x] + 1, d[y - 1, x - 1] + 1.414 if x else big,
                              d[y - 1, x + 1] + 1.414 if x + 1 < w else big)
            if x:
                d[y, x] = min(d[y, x], d[y, x - 1] + 1)
    for y in range(h - 1, -1, -1):
        for x in range(w - 1, -1, -1):
            if y + 1 < h:
                d[y, x] = min(d[y, x], d[y + 1, x] + 1, d[y + 1, x + 1] + 1.414 if x + 1 < w else big,
                              d[y + 1, x - 1] + 1.414 if x else big)
            if x + 1 < w:
                d[y, x] = min(d[y, x], d[y, x + 1] + 1)
    return d


def calibrate(run_dir: Path, map_dir: Path, positions: list[tuple[float, float]]) -> dict | None:
    """Where the robot's origin lies on the map (u0, v0, in cells), fitted to the RunMap track.
    None when the run's grid is not the map's (doors closed: the run covers only part of it) or the
    track does not fit."""
    run = json.loads((run_dir / "runmap.json").read_text())
    floor = json.loads((map_dir / "floormap.json").read_text())
    if (run["width"], run["height"]) != (floor["width"], floor["height"]):
        return None
    grid = _grid(run)
    dist = _distance_map(grid == 3)
    h, w = grid.shape
    pts = np.array(positions[:: max(1, len(positions) // 600)], dtype=float)
    pts[:, 1] *= -1

    def cost(u0: float, v0: float, upc: float) -> float:
        q = pts / upc + (u0, v0)
        u = np.clip(np.rint(q[:, 0]).astype(int), 0, w - 1)
        v = np.clip(np.rint(q[:, 1]).astype(int), 0, h - 1)
        return float(np.minimum(dist[v, u], 3).mean())

    track = np.argwhere(grid == 3)
    if len(track) < 50:
        return None
    # the scale is the robot's (UNITS_PER_CELL); only the origin depends on map and dock. Start with the
    # track's centre against the positions' centre, then a coarse and finer searches around it.
    upc = UNITS_PER_CELL
    cv, cu = track.mean(0)
    u0, v0 = cu - (pts[:, 0] / upc).mean(), cv - (pts[:, 1] / upc).mean()
    best = (math.inf, u0, v0)
    for step, reach in ((1.0, 30), (0.25, 2), (0.05, 0.5)):
        _, cu0, cv0 = best
        for du in np.arange(-reach, reach + step / 2, step):
            for dv in np.arange(-reach, reach + step / 2, step):
                c = cost(cu0 + du, cv0 + dv, upc)
                if c < best[0]:
                    best = (c, cu0 + du, cv0 + dv)
    _, u0, v0 = best
    if best[0] > 1.5:  # mean distance to the track in cells (clipped at 3)
        return None
    return {"u0": round(float(u0), 2), "v0": round(float(v0), 2), "upc": upc, "fit": round(best[0], 2),
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
