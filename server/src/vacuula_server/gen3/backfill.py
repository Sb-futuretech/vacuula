"""Reading gen3 runs from the robot's black box afterwards: runs this server did not read live (it was
not running, or joined late) get what live_position would have made of them. For now that is the
lidar grid (gen3/lidar.py) next to the run's maps.

The robot keeps its newest black box files (/emmc/black_box, about 500 MB on a D7: the last 4 or 5
days) and hands any of them out through bbtail.sh (installer, port VACUULA_BB_PORT). Files copied off a
robot earlier can be put into DATA_DIR/bb_import/<serial>/ and are read the same way.

A file is not split by runs: its packets are dated by the robot's text messages ("Nov 08 17:20:40: ...",
the robot's local time, which the installer set to this server's time zone) together with the packets'
24 MHz clock, and every packet inside a run's start and end (from the robot's upload) goes to that run.

Only while the robot is docked and idle and nothing reads it live; a file once read is not read again.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import select

from vacuula_server.constants import DATA_DIR, MAPS_DIR
from vacuula_server.db import get_session
from vacuula_server.env import BB_KEY
from vacuula_server.gen3 import blackbox, live_position
from vacuula_server.models.run import Gen3__Run
from vacuula_server.server_tz import server_timezone
from vacuula_server.state import robot_connections

logger = logging.getLogger(__name__)

STATE_FILE = DATA_DIR / "lidar_backfill.json"
IMPORT_DIR = DATA_DIR / "bb_import"
START_DELAY_S = 120        # after the server started
CHECK_EVERY_S = 15 * 60
PAUSE_S = 0.1              # between two requests to the robot (inetd allows 1000 a minute)
MISSES_TO_STOP = 10        # looking for older files: this many missing names in a row end the search
RUN_MARGIN_S = 20          # packets this long before a run's start and after its end still count
RUNS_SINCE_DAYS = 30       # older runs are not looked for
MIN_TURNS = 20             # fewer lidar turns than this: nothing kept for the run
CLOCK_HZ = 24_000_000
PAST_END = 999_999_999_999  # an offset past any file: bbtail answers with its header line only

TEXT_TIME = re.compile(rb"([A-Z][a-z]{2}) ([ \d]\d) (\d\d):(\d\d):(\d\d): ")
MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}

_lock = threading.Lock()


def start() -> None:
    if not BB_KEY:
        return
    threading.Thread(target=_loop, name="lidar-backfill", daemon=True).start()


def _loop() -> None:
    time.sleep(START_DELAY_S)
    while True:
        for serial in list(robot_connections):
            if "-" not in serial:  # gen3 serials only
                continue
            try:
                run_pass(serial)
            except Exception:
                logger.exception("Backfill of %s failed", serial)
        time.sleep(CHECK_EVERY_S)


def _idle(serial: str) -> bool:
    """Docked, not busy, and not read live right now."""
    return serial not in live_position._readers and live_position._last_docked.get(serial, False)


def _host(serial: str) -> str | None:
    conn = robot_connections.get(serial)
    return getattr(conn, "host", None) if conn else None


# ---- what is still to do ----------------------------------------------------------------------------
def _runs(serial: str) -> list[dict]:
    """The robot's runs of the last RUNS_SINCE_DAYS that have their maps here but no lidar grid yet:
    {"id", "start", "end" (UTC seconds), "map_id", "folder"}, oldest first."""
    since = (datetime.now(timezone.utc) - timedelta(days=RUNS_SINCE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with get_session() as db:
        rows = db.execute(select(Gen3__Run.id, Gen3__Run.persistent_map, Gen3__Run.run).where(Gen3__Run.robot == serial)).all()
    out = []
    for run_id, map_id, run in rows:
        start, end = (run or {}).get("start_at"), (run or {}).get("end_at")
        folder = MAPS_DIR / serial / run_id
        if not start or not end or start < since or not folder.is_dir() or (folder / live_position.LIDAR_FILE).exists():
            continue
        out.append({"id": run_id, "map_id": map_id, "folder": folder,
                    "start": _utc(start), "end": _utc(end)})
    return sorted(out, key=lambda r: r["start"])


def _utc(iso: str) -> float:
    return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def _load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _mark_done(serial: str, name: str, info: dict) -> None:
    state = _load_state()
    state.setdefault(serial, {}).setdefault("files", {})[name] = info
    STATE_FILE.write_text(json.dumps(state, indent=1))


def _robot_files(serial: str, host: str) -> list[tuple[str, int]]:
    """The black box files the robot still has, oldest first, without the newest (still written)."""
    (newest, _, _, _), _ = live_position._fetch(host, "-", PAST_END)
    n = int(newest[6:16])
    found, misses = [], 0
    for k in range(n - 1, 0, -1):
        name = f"BBLog_{k:010d}.nz.enc.bin"
        (got, size, _, _), _ = live_position._fetch(host, name, PAST_END)  # header only
        time.sleep(PAUSE_S)
        if got == name:
            found.append((name, size))
            misses = 0
        else:
            misses += 1
            if misses >= MISSES_TO_STOP:
                break
    return found[::-1]


# ---- reading ----------------------------------------------------------------------------------------
def run_pass(serial: str) -> None:
    """Read the files not read yet (imported ones first, then the robot's), while there are runs without
    a lidar grid and the robot stays idle."""
    if not _lock.acquire(blocking=False):
        return
    try:
        runs = _runs(serial)
        if not runs:
            return
        done = _load_state().get(serial, {}).get("files", {})
        imported = sorted((IMPORT_DIR / serial).glob("BBLog_*.nz.enc.bin")) if (IMPORT_DIR / serial).is_dir() else []
        for path in imported:
            if path.name not in done:
                saved = _read(serial, _chunks_of_file(path), runs)
                _mark_done(serial, path.name, {"from": "import", "runs": saved, "at": time.time()})
                runs = [r for r in runs if r["id"] not in saved]
        host = _host(serial)
        if not runs or not host or not _idle(serial):
            return
        for name, size in _robot_files(serial, host):
            if name in done or not _idle(serial):
                continue
            logger.info("Backfill of %s: reading %s from the robot (%.0f MB)", serial, name, size / 1e6)
            try:
                saved = _read(serial, _chunks_from_robot(serial, host, name), runs)
            except _Interrupted:
                logger.info("Backfill of %s: %s interrupted (the robot is busy), later again", serial, name)
                return
            _mark_done(serial, name, {"from": "robot", "size": size, "runs": saved, "at": time.time()})
            runs = [r for r in runs if r["id"] not in saved]
            if not runs:
                return
    finally:
        _lock.release()


class _Interrupted(Exception):
    pass


def _chunks_from_robot(serial: str, host: str, name: str):
    offset = 0
    while True:
        if not _idle(serial):
            raise _Interrupted
        (got, size, start, _), data = live_position._fetch(host, name, offset)
        if got != name:
            raise _Interrupted  # deleted meanwhile: nothing more of it
        data = data[offset - start:]
        if not data:
            return
        offset += len(data)
        yield data
        if offset >= size:
            return
        time.sleep(PAUSE_S)


def _chunks_of_file(path: Path):
    with path.open("rb") as f:
        while chunk := f.read(4 << 20):
            yield chunk


def _read(serial: str, chunks, runs: list[dict]) -> list[str]:
    """One black box file: its packets dated and handed to the run they belong to; the lidar grid of
    every run that got enough of it is saved. The ids of those runs."""
    tz = ZoneInfo(server_timezone())
    stream = blackbox.PacketStream()
    buf = b""
    clock_last, wraps = None, 0
    ref: tuple[float, float] | None = None  # (clock s, UTC s) of the last dated text
    current: dict | None = None
    session: live_position.Session | None = None
    saved: list[str] = []

    def finish() -> None:
        if current and session and session.lidar.scans >= MIN_TURNS:
            session.run_folder = str(current["folder"])
            session.map_id = session.map_id or current["map_id"]
            live_position._save_lidar(serial, session)
            saved.append(current["id"])
            logger.info("Backfill of %s: run %s, %d lidar turns", serial, current["id"], session.lidar.scans)

    for chunk in chunks:
        buf += chunk
        blocks, used = blackbox.split_blocks(buf)
        buf = buf[used:]
        for block in blocks:
            try:
                payload = blackbox.block_payload(block, BB_KEY)
            except Exception:
                continue
            for ptype, clock, pdata in stream.feed(payload):
                if clock_last is not None and clock < clock_last - (1 << 31):
                    wraps += 1
                clock_last = clock
                secs = (clock + (wraps << 32)) / CLOCK_HZ
                if ptype == blackbox.PKT_TEXT and (when := _text_time(pdata, tz)) is not None:
                    ref = (secs, when)
                if ref is None:
                    continue
                t = ref[1] + secs - ref[0]
                run = next((r for r in runs if r["start"] - RUN_MARGIN_S <= t <= r["end"] + RUN_MARGIN_S), None)
                if run is not current:
                    finish()
                    current = run
                    session = live_position.Session(docked_at_start=True) if run else None
                if session is not None:
                    live_position.feed(serial, session, ptype, clock, pdata)
    finish()
    return saved


def _text_time(text: bytes, tz: ZoneInfo) -> float | None:
    """The robot's local time a text packet starts with, as UTC seconds (the year: the one that puts it
    into the past)."""
    m = TEXT_TIME.search(text[:40])
    if not m or m.group(1).decode() not in MONTHS:
        return None
    now = datetime.now(tz)
    try:
        when = datetime(now.year, MONTHS[m.group(1).decode()], int(m.group(2)), int(m.group(3)), int(m.group(4)),
                        int(m.group(5)), tzinfo=tz)
    except ValueError:
        return None
    if when > now + timedelta(days=1):
        when = when.replace(year=now.year - 1)
    return when.timestamp()
