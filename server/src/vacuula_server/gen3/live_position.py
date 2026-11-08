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
from vacuula_server.db import get_session
from vacuula_server.gen3 import blackbox, coverage
from vacuula_server.gen3.data import Gen3MapBoundaries
from vacuula_server.models.run import Gen3__Run
from sqlalchemy import select
from vacuula_server.state import push_to_app, robot_connections

logger = logging.getLogger(__name__)

STATE_BUSY = 2
POLL_S = 2.0               # 30 requests a minute: below inetd's default limit (40), even on a robot without nowait.1000
RETRY_S = 5.0              # after a failed request: don't keep knocking (inetd shuts a port it finds busy)
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
    run_folder: str | None = None   # where the robot's maps of this run went (its track is saved there)
    zone_cells: list[list[float]] | None = None  # the zone it cleaned, in cells of its run map


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
            reader.stop.wait(RETRY_S if reader.failing else POLL_S)
    finally:
        with _lock:
            _readers.pop(reader.serial, None)
            if session := _sessions.get(reader.serial):
                session.ended_at = time.time()
                logger.info("Live position of %s: run ended, %d positions (map %s); %d reads, %d failed, slowest %.1f s",
                            reader.serial, len(session.positions), session.map_id, reader.reads, reader.failed,
                            reader.slowest)
        # the maps came while the last blocks were still read: save the track again, complete now
        if session and session.run_folder:
            _save_track(reader.serial, session.run_folder, list(session.positions), session.zone_cells)


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
def _to_cells(cal: dict, x: float, y: float) -> tuple[float, float]:
    """A position in map cells (the map image has y down)."""
    return cal["u0"] + x / cal["upc"], cal["v0"] - y / cal["upc"]


def _send(serial: str, session: Session, pos: blackbox.Coords) -> None:
    cal = _calibration(serial, session.map_id) if session.docked_at_start and session.map_id else None
    if not cal:
        return
    u, v = _to_cells(cal, pos.x, pos.y)
    push_to_app(serial, "livePosition", {
        "mapId": session.map_id,
        "u": u,
        "v": v,
        "heading": -math.degrees(pos.heading),
        "t": time.time(),
    })


def live_track(serial: str) -> dict | None:
    """The way of the clean running now (or just ended), for an app that opens or reloads meanwhile:
    map id and points in map cells (2 a second); None if there is none to show."""
    with _lock:
        session = _sessions.get(serial)
        if not session or not session.docked_at_start or not session.map_id:
            return None
        if session.ended_at and time.time() - session.ended_at > IDLE_STOP_S:
            return None
        positions = list(session.positions)
    cal = _calibration(serial, session.map_id)
    if not cal or not positions:
        return None
    return {
        "mapId": session.map_id,
        "points": [[round(c, 2) for c in _to_cells(cal, x, y)] for x, y in positions[::TRACK_EVERY]]
                  + [[round(c, 2) for c in _to_cells(cal, *positions[-1])]],
        "t": time.time(),
    }


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
    session.run_folder = job_folder
    session.zone_cells = _zone_cells(serial, run, Path(job_folder))
    _save_track(serial, job_folder, positions, session.zone_cells)
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
        logger.info("Live position of %s: run %s not used for calibration: no clean start and end on the dock "
                    "on map %s (failed docking, start away from the dock, other grid, or the track does not fit)",
                    serial, run.get("id"), map_id)
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


def _fit_origin(grid: np.ndarray, positions: list[tuple[float, float]], upc: float) -> tuple[float, float, float] | None:
    """Where the robot's origin lies in `grid` (u0, v0, in cells) so its positions run along the grid's
    track (value 3), and the mean distance to it in cells (clipped at 3). None without a track."""
    track = np.argwhere(grid == 3)
    if len(track) < 50 or len(positions) < 20:
        return None
    dist = _distance_map(grid == 3)
    h, w = grid.shape
    pts = np.array(positions[:: max(1, len(positions) // 600)], dtype=float)
    pts[:, 1] *= -1

    def cost(u0: float, v0: float) -> float:
        q = pts / upc + (u0, v0)
        u = np.clip(np.rint(q[:, 0]).astype(int), 0, w - 1)
        v = np.clip(np.rint(q[:, 1]).astype(int), 0, h - 1)
        return float(np.minimum(dist[v, u], 3).mean())

    # start with the track's centre against the positions' centre, then a coarse and finer searches
    cv, cu = track.mean(0)
    best = (math.inf, cu - (pts[:, 0] / upc).mean(), cv - (pts[:, 1] / upc).mean())
    for step, reach in ((1.0, 30), (0.25, 2), (0.05, 0.5)):
        _, cu0, cv0 = best
        for du in np.arange(-reach, reach + step / 2, step):
            for dv in np.arange(-reach, reach + step / 2, step):
                c = cost(cu0 + du, cv0 + dv)
                if c < best[0]:
                    best = (c, cu0 + du, cv0 + dv)
    return float(best[1]), float(best[2]), best[0]


MAX_FIT = 1.5  # mean distance of the positions to the track, cells: worse is not trusted
RUN_DOCK = 100  # the dock block in a RunMap (only in runs that ended on the dock)
# the origin (robot centre at the start) lies this close to the dock block, cells: about 50 cm; on a D7
# it was 7 cells away on two runs from the dock
MAX_ORIGIN_FROM_DOCK = 12


def calibrate(run_dir: Path, map_dir: Path, positions: list[tuple[float, float]]) -> dict | None:
    """Where the robot's origin lies on the map (u0, v0, in cells), fitted to the RunMap track.
    None when the run's grid is not the map's (doors closed: the run covers only part of it) or the
    track does not fit. The scale is the robot's (UNITS_PER_CELL); only the origin depends on map and
    dock."""
    run = json.loads((run_dir / "runmap.json").read_text())
    floor = json.loads((map_dir / "floormap.json").read_text())
    if (run["width"], run["height"]) != (floor["width"], floor["height"]):
        return None
    grid = _grid(run)
    # positions count from where the run started: only a run that started (and ended) on the dock says
    # where the origin lies. The run must end with its dock block (a run that failed to dock has none),
    # and the fitted origin must lie next to it (a start off the dock, e.g. after a failed docking, is
    # reported as docked by the robot now and then)
    dock = np.argwhere(grid == RUN_DOCK)
    if len(dock) == 0:
        return None
    fit = _fit_origin(grid, positions, UNITS_PER_CELL)
    if fit is None or fit[2] > MAX_FIT:
        return None
    u0, v0, c = fit
    dv, du = dock.mean(0)
    if math.hypot(u0 - du, v0 - dv) > MAX_ORIGIN_FROM_DOCK:
        return None
    return {"u0": round(u0, 2), "v0": round(v0, 2), "upc": UNITS_PER_CELL, "fit": round(c, 2),
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


TRACK_EVERY = 5  # every 5th position (2 per second) is plenty for a line


def _zone_cells(serial: str, run: dict, run_dir: Path) -> list[list[float]] | None:
    """The zone the run cleaned as cells of its run map, if the run map is its stored map's grid."""
    zone = run.get("zone") or {}
    map_id = zone.get("mapId") or run.get("persistent_map_id")
    if not zone.get("id") or not map_id:
        return None
    try:
        stored = json.loads((MAPS_DIR / serial / map_id / "floormap.json").read_text())
        runmap = json.loads((run_dir / "runmap.json").read_text())
    except (OSError, ValueError):
        return None
    if (stored["width"], stored["height"]) != (runmap["width"], runmap["height"]):
        return None
    with get_session() as db:
        boundaries = db.execute(select(Gen3MapBoundaries.boundaries).where(Gen3MapBoundaries.map_id == map_id)).scalar()
    for b in boundaries or []:
        if isinstance(b, dict) and b.get("id") == zone["id"] and b.get("vertices"):
            return [[x * runmap["width"], y * runmap["height"]] for x, y in b["vertices"]]
    return None


def _save_coverage(serial: str, run_id: str, result: dict | None) -> None:
    """The run's cleaned share into its record, for the statistics (without the missed cells)."""
    with get_session() as db:
        grun = db.get(Gen3__Run, run_id)
        if grun is None:
            return
        summary = {k: v for k, v in (result or {}).items() if k not in ("missed", "cleaned", "width", "height")} or None
        grun.run = {**grun.run, "coverage": summary}
        db.commit()


def _save_track(serial: str, run_folder: str, positions: list[tuple[float, float]],
                zone_cells: list[list[float]] | None = None) -> None:
    """The run's way as cells of its own run map (track.json next to it, see GET .../run/<id>/track):
    the positions laid onto the run's RunMap track, so it fits whatever part of the map the run covers."""
    try:
        run = json.loads((Path(run_folder) / "runmap.json").read_text())
        fit = _fit_origin(_grid(run), positions, UNITS_PER_CELL)
        if fit is None or fit[2] > MAX_FIT:
            logger.info("Live position of %s: no track for %s: positions do not fit its run map", serial, run_folder)
            return
        u0, v0, c = fit
        cells = [[round(u0 + x / UNITS_PER_CELL, 2), round(v0 - y / UNITS_PER_CELL, 2)]
                 for x, y in positions[::TRACK_EVERY]]
        floor = _grid(json.loads((Path(run_folder) / "floormap.json").read_text()))
        cov = coverage.measure(floor, cells, zone_cells)
        (Path(run_folder) / "track.json").write_text(json.dumps({"cells": cells, "fit": round(c, 2), "coverage": cov}))
        _save_coverage(serial, Path(run_folder).name, cov)
        logger.info("Live position of %s: track of %d points saved for %s (fit %.2f), cleaned %s%% of %s",
                    serial, len(cells), Path(run_folder).name, c, cov and cov["percent"],
                    "its zone" if zone_cells else "the free floor")
    except Exception as e:
        logger.warning("Live position of %s: track for %s not saved: %s", serial, run_folder, e)
