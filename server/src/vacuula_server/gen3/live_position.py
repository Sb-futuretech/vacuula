"""Live position of a gen3 robot while it cleans, read from its black box log.

The robot writes its position every 100 ms into the black box (see gen3/blackbox.py) once e.MMC logging
is on. A read-only script on the robot (installer: bbtail.sh behind inetd, port VACUULA_BB_PORT) hands
out the newest log file from a byte offset. While the robot is busy this module asks it once a second
for the new bytes, decodes the newest position and sends it to the app as event "livePosition".

Positions are in the robot's own unit and frame (y up); once it has found itself on its map after
leaving the dock that frame is the same on every run (the dock lies at the same place in it). Where its
origin lies on the map comes from the marks the robot draws into every RunMap: where it started
cleaning (value 150, its first position on the map) and where it ended (value 200, its last). Each run
gives the origin to a third of a cell; a map keeps the median of its last LEARN_RUNS runs. Until a map
has one nothing is sent for it.
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
from vacuula_server.gen3 import blackbox, coverage, floor_type
from vacuula_server.gen3.data import Gen3MapBoundaries
from vacuula_server.models.run import Gen3__Run
from sqlalchemy import select
from vacuula_server import notifications
from vacuula_server.state import push_to_app, robot_connections

logger = logging.getLogger(__name__)

STATE_BUSY = 2
POLL_S = 2.0               # 30 requests a minute: below inetd's default limit (40), even on a robot without nowait.1000
RETRY_S = 5.0              # after a failed request: don't keep knocking (inetd shuts a port it finds busy)
FETCH_TIMEOUT_S = 15       # the robot answers in 0.3 s at rest; while cleaning it is busier
IDLE_STOP_S = 20            # keep reading this long after the robot left BUSY (last blocks)
MAX_BUFFER = 1 << 20        # raw bytes kept while waiting for a whole block
CATCH_UP = 256 * 1024       # joining a run late: start this far before the end of the file
UNITS_PER_CELL = 525_000    # D7: robot units per map cell; 12 runs over all rooms lie on their RunMap tracks
                            # with one origin at this scale (2026-11-10; 445,400 before was a false fit)
SESSION_KEEP_S = 15 * 60    # a run's positions wait this long for its map upload
CALIBRATION_FILE = DATA_DIR / "live_position.json"

MAP_ID_RE = re.compile(rb"Using Map ID (\S+) to begin persistent cleaning")

# Problems the robot writes into its black box as text, placed where it was then: (kind, pattern; the
# pattern's first group, if any, is the detail)
EVENT_PATTERNS = (
    ("bump", re.compile(rb"PFEVENT_([A-Z_]*BUMP)")),
    ("tilt", re.compile(rb"Robot very tilted")),
    ("lost", re.compile(rb"SET_ALERT UI_ALERT_RECOVERING_LOCATION")),
    ("unreachable", re.compile(rb"SET_ALERT UI_ALERT_NAV_FLOORPLAN_ZONE_UNREACHABLE")),
    ("slip", re.compile(rb"Slip detected")),
    ("stuck", re.compile(rb"(?i)possibly stuck|robot is stuck|(UI_ERROR_[A-Z_]*STUCK[A-Z_]*)")),
    ("dock_tilted", re.compile(rb"MSG_BASE_DOCKING_TILTED")),
    ("off_base", re.compile(rb"slipped off my charging base")),
)
EVENT_GAP_S = 3            # the same kind again within this time and EVENT_GAP_CELLS is the same event
EVENT_GAP_CELLS = 2
CLOCK_HZ = 24_000_000     # the black box packets' clock
PROBLEMS_FILE = DATA_DIR / "live_problems.json"
LAST_SEEN_FILE = DATA_DIR / "live_last.json"  # per robot: its last position shown on its map
PROBLEMS_KEEP = 3000       # per map, newest kept
# not moved more than STUCK_MOVE_CELLS for STUCK_S while cleaning: stuck (a Telegram message, once)
STUCK_S = 120
STUCK_MOVE_CELLS = 3
CLEANING_ACTIONS = {1, 2, 11, 12}
# Leaving the dock the robot counts from where it stood, drives off about 35 cm, stands ~20 s to find
# itself on its map, then its position jumps into the map's frame (seen on every run of a D7,
# 2026-11-08). What came before that jump is in another frame: dropped. A jump is a step this large
# between two positions; only one within START_POSITIONS of the start counts as that one.
JUMP_CELLS = 3
START_POSITIONS = 900  # house, spot, map cleaning, exploring (not docking or recharging)


@dataclass
class Session:
    docked_at_start: bool
    map_id: str | None = None
    positions: list[tuple[float, float]] = field(default_factory=list)
    ended_at: float | None = None
    run_folder: str | None = None   # where the robot's maps of this run went (its track is saved there)
    zone_cells: list[list[float]] | None = None  # the zone it cleaned, in cells of its run map
    events: list[dict] = field(default_factory=list)  # {"kind", "detail", "x", "y", "t"} in robot units
    last_pos: tuple[float, float] | None = None
    anchor: tuple[float, float] | None = None  # where it was when it last moved
    still_since: float = 0.0
    stuck_reported: bool = False
    floor: list[tuple[float, float, int, float]] = field(default_factory=list)  # (x, y, load, heading) where the brush was
    last_heading: float = 0.0
    from_start: bool = False        # positions[0] is where it started on its map (read from the run's start)
    saved: bool = False             # problems and floor type of this run are on its map
    hidden_why: str | None = None   # why the live position is not shown (logged once per reason)


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
_last_action: dict[str, int | None] = {}
_last_seen: dict[str, dict] = {}


# ---- robot state ------------------------------------------------------------------------------------
def on_state(serial: str, state: dict) -> None:
    if not BB_KEY:
        return
    busy = state.get("state") == STATE_BUSY
    _last_action[serial] = state.get("action")
    with _lock:
        reader = _readers.get(serial)
        if not busy:
            _last_docked[serial] = bool((state.get("details") or {}).get("isDocked"))
            if reader and reader.idle_since is None:
                reader.idle_since = time.time()
            return
        # the robot names its map in every state while cleaning on it, as well as once in its black box
        # (which this server misses if it starts reading late): either will do
        map_id = (state.get("cleaning") or {}).get("mapId") or None
        if reader:
            reader.idle_since = None
            if (session := _sessions.get(serial)) and map_id and not session.map_id:
                session.map_id = map_id
            return
        conn = robot_connections.get(serial)
        host = getattr(conn, "host", None) if conn else None
        if not host:
            return
        prev = _sessions.get(serial)
        if prev and prev.ended_at and not prev.saved and not prev.run_folder and not _last_docked.get(serial):
            # it went on after a pause or an error (stuck, brush cleaned) away from the dock: the same run
            prev.ended_at = None
            logger.info("Live position of %s: run goes on after a pause, %d positions so far",
                        serial, len(prev.positions))
        else:
            _sessions[serial] = Session(docked_at_start=_last_docked.get(serial, False), map_id=map_id)
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
        _keep_last_seen(reader.serial)
        if session:
            _save_run(reader.serial, session)


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
        for ptype, clock, pdata in reader.stream.feed(payload):
            if ptype == blackbox.PKT_COORDS:
                latest = blackbox.Coords.parse(pdata)
                if session and session.last_pos and not session.from_start and len(session.positions) < START_POSITIONS and math.hypot(
                        latest.x - session.last_pos[0], latest.y - session.last_pos[1]) > JUMP_CELLS * UNITS_PER_CELL:
                    logger.info("Live position of %s: on its map now, %d positions of leaving the dock dropped",
                                reader.serial, len(session.positions))
                    session.positions.clear()
                    session.floor.clear()
                    session.events.clear()
                    session.anchor = None
                    session.from_start = True
                if session:
                    session.positions.append((latest.x, latest.y))
                    session.last_pos = (latest.x, latest.y)
                    session.last_heading = latest.heading
            elif ptype == floor_type.PKT_MOTORS and session and session.last_pos is not None:
                if (load := floor_type.sample(pdata)) is not None:
                    # where the brush is: ahead of the centre, in the robot's frame (heading counter-clockwise)
                    ahead = floor_type.BRUSH_AHEAD_CELLS * UNITS_PER_CELL
                    x, y = session.last_pos
                    session.floor.append((x + ahead * math.cos(session.last_heading),
                                          y + ahead * math.sin(session.last_heading), load, session.last_heading))
            elif ptype == blackbox.PKT_TEXT and session:
                if m := MAP_ID_RE.search(pdata):
                    session.map_id = m.group(1).decode(errors="replace")
                _note_events(session, pdata, clock)
    if latest and session:
        _send(reader.serial, session, latest)
    if session:
        _check_stuck(reader.serial, session)


def _note_events(session: Session, text: bytes, clock: int) -> None:
    """Problems in one text packet of the black box, at the robot's last position."""
    if session.last_pos is None:
        return
    x, y = session.last_pos
    now = time.time()
    tick = clock / CLOCK_HZ  # the robot's clock: events of one block come in together, not seconds apart
    for kind, pattern in EVENT_PATTERNS:
        if not (m := pattern.search(text)):
            continue
        detail = (m.group(1) or b"").decode(errors="replace") if m.groups() and m.group(1) else ""
        near = EVENT_GAP_CELLS * UNITS_PER_CELL
        if any(e["kind"] == kind and abs(tick - e["tick"]) < EVENT_GAP_S and math.hypot(e["x"] - x, e["y"] - y) < near
               for e in session.events[-20:]):
            continue
        session.events.append({"kind": kind, "detail": detail, "x": x, "y": y, "t": now, "tick": tick})


def _check_stuck(serial: str, session: Session) -> None:
    """Telegram (via notifications) when the robot has not moved for STUCK_S while cleaning, and when it
    moves again."""
    if session.last_pos is None:
        return
    now = time.time()
    if session.anchor is None or math.hypot(session.last_pos[0] - session.anchor[0],
                                            session.last_pos[1] - session.anchor[1]) > STUCK_MOVE_CELLS * UNITS_PER_CELL:
        if session.stuck_reported:
            session.stuck_reported = False
            notifications.add(serial, "unstuck", data=_where(serial, session))
        session.anchor, session.still_since = session.last_pos, now
        return
    if (not session.stuck_reported and now - session.still_since > STUCK_S
            and _last_action.get(serial) in CLEANING_ACTIONS):
        session.stuck_reported = True
        notifications.add(serial, "stuck", data={**_where(serial, session), "minutes": STUCK_S // 60})


def _where(serial: str, session: Session) -> dict:
    """The robot's position in map coordinates (metres, like the rulers: a cell is 4 cm) for messages."""
    cal = _calibration(serial, session.map_id) if session.docked_at_start and session.map_id else None
    if not cal or session.last_pos is None:
        return {}
    u, v = _to_cells(cal, *session.last_pos)
    return {"mapId": session.map_id, "xM": round(u * 0.04, 2), "yM": round(v * 0.04, 2)}


def _save_run(serial: str, session: Session) -> None:
    """Once the run is read to its end and its maps are here: where its origin lies (from its RunMap's
    marks), its track for the run view, and its problems and floor type onto its stored map."""
    if session.saved or not session.ended_at or not session.run_folder or len(session.positions) < 2:
        return
    session.saved = True
    run_id = Path(session.run_folder).name
    try:
        runmap = json.loads((Path(session.run_folder) / "runmap.json").read_text())
    except (OSError, ValueError) as e:
        logger.info("Live position of %s: run %s has no run map (%s)", serial, run_id, e)
        return
    origin = _marker_origin(_grid(runmap), session)
    if not origin:
        logger.info("Live position of %s: run %s has no start or end mark in its run map: not placed", serial, run_id)
        return
    _save_track(serial, session, origin)
    if not session.map_id:
        return
    try:
        stored = json.loads((MAPS_DIR / serial / session.map_id / "floormap.json").read_text())
    except (OSError, ValueError):
        logger.info("Live position of %s: map %s of run %s not stored here", serial, session.map_id, run_id)
        return
    if (stored["width"], stored["height"]) != (runmap["width"], runmap["height"]):
        # doors closed: its run map is a smaller cut of the stored map, so its marks don't give the stored
        # map's origin. The robot still counts in its stored map's frame: the origin learnt for the map
        # places the run (it does not learn from it).
        cal = _calibration(serial, session.map_id) if session.docked_at_start else None
        if not cal:
            logger.info("Live position of %s: run %s is not in the grid of its map (doors closed?) and the map "
                        "has no origin yet: problems and floor type not kept", serial, run_id)
            return
        logger.info("Live position of %s: run %s is not in the grid of its map (doors closed?): problems and "
                    "floor type placed with the map's origin", serial, run_id)
        _save_problems(serial, session, cal)
        _save_floor(serial, session, cal)
        return
    if not _learn(serial, session.map_id, origin, run_id):
        return
    _save_problems(serial, session, origin)
    _save_floor(serial, session, origin)


def _save_floor(serial: str, session: Session, cal: dict) -> None:
    """The run's brush load onto its map (gen3/floor_type.py), in map cells."""
    if not session.floor:
        return
    try:
        # across the brush: perpendicular to the heading; in map cells y is down
        floor_type.add_run(serial, session.map_id, [(*_to_cells(cal, x, y), load, -math.sin(h), -math.cos(h))
                                                    for x, y, load, h in session.floor])
    except Exception as e:
        logger.warning("Floor type of %s not saved: %s", serial, e)


def problems(serial: str, map_id: str) -> list[dict]:
    """Problems recorded on a map over the last runs: {"kind", "detail", "u", "v", "run", "at"} in map cells."""
    try:
        return json.loads(PROBLEMS_FILE.read_text()).get(serial, {}).get(map_id, [])
    except (OSError, ValueError):
        return []


def _save_problems(serial: str, session: Session, cal: dict) -> None:
    """The run's problems onto its map, in map cells."""
    if not session.events:
        return
    run_id = Path(session.run_folder).name if session.run_folder else None
    at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    new = [{"kind": e["kind"], "detail": e["detail"], "run": run_id, "at": at,
            **dict(zip(("u", "v"), (round(c, 2) for c in _to_cells(cal, e["x"], e["y"]))))}
           for e in session.events]
    try:
        data = json.loads(PROBLEMS_FILE.read_text())
    except (OSError, ValueError):
        data = {}
    kept = data.setdefault(serial, {}).setdefault(session.map_id, [])
    kept.extend(new)
    data[serial][session.map_id] = kept[-PROBLEMS_KEEP:]
    PROBLEMS_FILE.write_text(json.dumps(data))
    logger.info("Live position of %s: %d problems of this run kept for map %s", serial, len(new), session.map_id)


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
        why = ("it did not start at the dock" if not session.docked_at_start else
               "no map id in the black box yet" if not session.map_id else
               f"no origin at this scale for map {session.map_id}")
        if why != session.hidden_why:
            session.hidden_why = why
            logger.info("Live position of %s: not shown, %s", serial, why)
        return
    u, v = _to_cells(cal, pos.x, pos.y)
    shown = {"mapId": session.map_id, "u": u, "v": v, "heading": -math.degrees(pos.heading), "t": time.time()}
    _last_seen[serial] = shown
    push_to_app(serial, "livePosition", shown)


def last_seen(serial: str) -> dict | None:
    """Where the robot was last shown on its map ({"mapId", "u", "v", "heading", "t"}), also after the
    run: it logs its position only while it cleans, so this is where it stopped (or the dock)."""
    if serial in _last_seen:
        return _last_seen[serial]
    try:
        return json.loads(LAST_SEEN_FILE.read_text()).get(serial)
    except (OSError, ValueError):
        return None


def _keep_last_seen(serial: str) -> None:
    """The last position into LAST_SEEN_FILE, so a restart of this server keeps it."""
    if serial not in _last_seen:
        return
    try:
        data = json.loads(LAST_SEEN_FILE.read_text())
    except (OSError, ValueError):
        data = {}
    data[serial] = _last_seen[serial]
    try:
        LAST_SEEN_FILE.write_text(json.dumps(data))
    except OSError as e:
        logger.warning("Live position of %s: last position not kept: %s", serial, e)


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
    cal = _load().get(serial, {}).get(map_id)
    return cal if cal and cal.get("upc") == UNITS_PER_CELL else None  # learnt at another scale: not used


def run_uploaded(serial: str, run: dict, job_folder: str) -> None:
    """A run's maps arrived: its track, coverage, problems and floor type (once read to its end), and
    where the robot's origin lies on its map."""
    with _lock:
        session = _sessions.get(serial)
    # the robot uploads its maps right at the end, while this server still reads its last blocks: a run
    # still being read counts, an older one only for SESSION_KEEP_S
    if not session or (session.ended_at and time.time() - session.ended_at > SESSION_KEEP_S):
        return
    session.run_folder = job_folder
    session.zone_cells = _zone_cells(serial, run, Path(job_folder))
    # the robot leaves its map's id out of some uploads although it cleaned on it (2026-11-08: 7 of 31,
    # their positions on the map as well as the others'): the id it named in its black box then
    session.map_id = run.get("persistent_map_id") or session.map_id
    _save_run(serial, session)


def _grid(meta: dict) -> np.ndarray:
    """A map json's RLE as a (height, width) array."""
    flat = np.concatenate([np.full(n, v, dtype=np.uint8) for v, n in meta["rle"]])
    return flat.reshape(meta["height"], meta["width"])


RUN_START, RUN_END = 150, 200  # marks in a RunMap: where the robot started on its map, and where it ended
MARKS_AGREE_CELLS = 2          # start and end mark give the same origin within this; else the end counts


def _marker_origin(runmap: np.ndarray, session: Session) -> dict | None:
    """Where the robot's origin lies in the run map's cells, from its start and end marks and the
    positions it had there ({"u0", "v0", "upc"}). The start counts only if this server read the run from
    its start; if the two disagree, the end counts (the positions were read to the run's end)."""
    found = []
    for mark, pos in ((RUN_END, session.positions[-1]), (RUN_START, session.positions[0] if session.from_start else None)):
        cells = np.argwhere(runmap == mark)
        if pos is None or len(cells) == 0:
            continue
        cv, cu = cells.mean(0)
        found.append((float(cu - pos[0] / UNITS_PER_CELL), float(cv + pos[1] / UNITS_PER_CELL)))
    if not found:
        return None
    u0, v0 = found[0]
    if len(found) == 2 and math.hypot(found[0][0] - found[1][0], found[0][1] - found[1][1]) <= MARKS_AGREE_CELLS:
        u0, v0 = (found[0][0] + found[1][0]) / 2, (found[0][1] + found[1][1]) / 2
    return {"u0": u0, "v0": v0, "upc": UNITS_PER_CELL}


LEARN_RUNS = 7    # the map's origin is the median of the last this many runs' origins
MAX_OFF_CELLS = 3  # once a map has 3 runs, a run this far off its origin is not taken (its fit went wrong),
                   # unless the next run is off the same way: then the dock was moved and the map starts over


def _learn(serial: str, map_id: str, origin: dict, run_id: str | None) -> bool:
    """One more run's origin for the map; the map's origin is the median of the last LEARN_RUNS. False
    if the run's origin is too far off the map's to be trusted (nothing of the run should go onto it)."""
    data = _load()
    cal = data.setdefault(serial, {}).get(map_id) or {}
    if cal.get("upc") != UNITS_PER_CELL:
        cal = {}  # runs at another scale: start over
    new = [round(origin["u0"], 2), round(origin["v0"], 2), run_id]
    runs = cal.get("runs") or []
    if len(runs) >= 3 and math.hypot(new[0] - cal["u0"], new[1] - cal["v0"]) > MAX_OFF_CELLS:
        last_off = cal.get("off")
        if last_off and math.hypot(new[0] - last_off[0], new[1] - last_off[1]) <= MAX_OFF_CELLS:
            # two runs in a row agree on a new place: the dock was moved, start over from these two
            logger.info("Live position of %s: map %s origin moved (dock moved?): two runs agree on u0 %.2f v0 %.2f",
                        serial, map_id, new[0], new[1])
            runs = [last_off]
        else:
            # off by itself: kept aside; the next run tells whether it was the dock or a bad fit
            cal["off"] = new
            data[serial][map_id] = cal
            CALIBRATION_FILE.write_text(json.dumps(data, indent=1))
            logger.info("Live position of %s: map %s origin from run %s (u0 %.2f v0 %.2f) not taken: %.1f cells off "
                        "the map's", serial, map_id, run_id, new[0], new[1],
                        math.hypot(new[0] - cal["u0"], new[1] - cal["v0"]))
            return False
    runs = runs[-(LEARN_RUNS - 1):] + [new]
    data[serial][map_id] = {
        "u0": round(float(np.median([r[0] for r in runs])), 2),
        "v0": round(float(np.median([r[1] for r in runs])), 2),
        "upc": UNITS_PER_CELL,
        "runs": runs,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    CALIBRATION_FILE.write_text(json.dumps(data, indent=1))
    logger.info("Live position of %s: map %s origin from run %s u0 %.2f v0 %.2f, map now u0 %.2f v0 %.2f (%d runs)",
                serial, map_id, run_id, origin["u0"], origin["v0"], data[serial][map_id]["u0"],
                data[serial][map_id]["v0"], len(runs))
    return True


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


def _save_track(serial: str, session: Session, origin: dict) -> None:
    """The run's way as cells of its own run map (track.json next to it, see GET .../run/<id>/track),
    with its coverage and problems."""
    folder = Path(session.run_folder)
    try:
        def cells(x: float, y: float) -> list[float]:
            u, v = _to_cells(origin, x, y)
            return [round(u, 2), round(v, 2)]
        track = [cells(x, y) for x, y in session.positions[::TRACK_EVERY]] + [cells(*session.positions[-1])]
        floor = _grid(json.loads((folder / "floormap.json").read_text()))
        cov = coverage.measure(floor, track, session.zone_cells)
        problems_here = [{"kind": e["kind"], "detail": e["detail"], **dict(zip(("u", "v"), cells(e["x"], e["y"])))}
                         for e in session.events]
        (folder / "track.json").write_text(json.dumps({"cells": track, "coverage": cov, "problems": problems_here}))
        _save_coverage(serial, folder.name, cov)
        logger.info("Live position of %s: track of %d points saved for %s (origin u0 %.2f v0 %.2f), cleaned %s%% of %s",
                    serial, len(track), folder.name, origin["u0"], origin["v0"], cov and cov["percent"],
                    "its zone" if session.zone_cells else "the free floor")
    except Exception as e:
        logger.warning("Live position of %s: track for %s not saved: %s", serial, folder.name, e)
