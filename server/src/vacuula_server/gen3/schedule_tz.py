"""Gen3 robots installed without a timezone run their schedule in UTC (NTP time, no zone).

The app works in the server's local time, so `setSchedule` / `getSchedule` are converted on their
way through. The offset a schedule was written with is kept per robot; after a DST switch the
robot's events are shifted so they keep their local time.

A robot set up with a timezone (newer installer) runs it in local time instead, and some run it on
a fixed offset of their own (e.g. UTC+2 after a reinstall). Which one is learned from the robot's
scheduled runs (`check_clock`): the conversion is adjusted for it and its events are moved so they
keep their local time, with a notification.
"""
from __future__ import annotations
import json
import logging
import threading

from datetime import datetime, timezone

from vacuula_server import notifications
from vacuula_server.conn import Gen2Gen3Conn
from vacuula_server.db import get_session
from vacuula_server.gen3.commands import ask
from vacuula_server.gen3.data import Gen3Data
from vacuula_server.server_tz import utc_offset_minutes
from vacuula_server.state import robot_connections

logger = logging.getLogger(__name__)

WEEK_MIN = 7 * 24 * 60
DST_CHECK_S = 10 * 60
UTC, LOCAL = "utc", "local"
# a scheduled run starts this many minutes after its event at most
START_LATE_MIN = 5
# robot clocks are whole quarter hours off UTC, within the range real timezones use
OFFSET_STEP_MIN = 15
MIN_OFFSET, MAX_OFFSET = -12 * 60, 14 * 60

# the robot's clock: LOCAL, or its fixed offset from UTC in minutes (UTC = 0)
Clock = str | int


def shift_events(events: list[dict], minutes: int) -> list[dict]:
    """Move each event by `minutes`, across midnight and the week if needed."""
    shifted = []
    for e in events:
        try:
            h, m = map(int, e["startTime"].split(":"))
            total = (int(e["day"]) * 24 * 60 + h * 60 + m + minutes) % WEEK_MIN
        except (KeyError, ValueError, TypeError):
            shifted.append(e)  # not an event we understand: pass it on unchanged
            continue
        shifted.append({**e, "day": total // (24 * 60), "startTime": f"{total // 60 % 24:02d}:{total % 60:02d}"})
    return shifted


def _set_recorded_offset(serial: str, offset: int) -> None:
    with get_session() as session:
        if data := session.get(Gen3Data, serial):
            data.schedule_utc_offset = offset
            session.commit()


def _parse_clock(value: str | None) -> Clock:
    if value == LOCAL:
        return LOCAL
    try:
        return int(value) if value and value != UTC else 0
    except ValueError:
        return 0


def _clock_code(value: Clock) -> str:
    return LOCAL if value == LOCAL else UTC if value == 0 else str(value)


def clock(serial: str) -> Clock:
    """The clock the robot runs its schedule on (UTC unless learned otherwise)."""
    with get_session() as session:
        data = session.get(Gen3Data, serial)
        return _parse_clock(data.schedule_clock if data else None)


def _set_clock(serial: str, value: Clock) -> None:
    with get_session() as session:
        if data := session.get(Gen3Data, serial):
            data.schedule_clock = _clock_code(value)
            session.commit()


def _to_local(value: Clock) -> int:
    return 0 if value == LOCAL else utc_offset_minutes() - value


def robot_to_local(serial: str) -> int:
    """Minutes to add to the robot's event times to get local time."""
    return _to_local(clock(serial))


def _recorded_offset(serial: str) -> int | None:
    with get_session() as session:
        data = session.get(Gen3Data, serial)
        return data.schedule_utc_offset if data else None


# ---- app commands on their way through ---------------------------------------------------------
def to_robot(serial: str, cmd: dict) -> dict:
    """setSchedule from the app (local time) -> the robot's clock."""
    if cmd.get("cmd") != "setSchedule" or not isinstance(cmd.get("params", {}).get("events"), list):
        return cmd
    params = {**cmd["params"], "events": shift_events(cmd["params"]["events"], -robot_to_local(serial))}
    return {**cmd, "params": params}


def from_robot(serial: str, cmd: dict, content, status: int | None):
    """The robot's reply, with getSchedule events in local time; remembers the offset of a written schedule."""
    if status != 200 or cmd.get("cmd") not in ("setSchedule", "getSchedule"):
        return content
    if cmd["cmd"] == "setSchedule":
        if clock(serial) != LOCAL:
            _set_recorded_offset(serial, utc_offset_minutes())
        return content
    try:
        reply = json.loads(content)
        reply["data"]["events"] = shift_events(reply["data"]["events"], robot_to_local(serial))
    except (ValueError, KeyError, TypeError):
        return content
    return json.dumps(reply).encode()


# ---- DST switch ---------------------------------------------------------------------------------
def _writable(events: list[dict]) -> list[dict]:
    """Events as read back, in the form setSchedule takes (`boundary` -> `boundaryId`)."""
    return [{k: v for k, v in e.items() if k != "boundary"} | ({"boundaryId": e["boundary"]["id"]} if e.get("boundary") else {})
            for e in events]


def _follow_dst(serial: str) -> None:
    if clock(serial) == LOCAL:
        return  # the robot follows DST itself
    recorded, current = _recorded_offset(serial), utc_offset_minutes()
    if recorded is None or recorded == current:
        return
    reply = ask(serial, {"cmd": "getSchedule"})
    if reply is None:
        return  # try again at the next check
    events = _writable(shift_events((reply.get("data") or {}).get("events") or [], recorded - current))
    if ask(serial, {"cmd": "setSchedule", "params": {"events": events}}) is None:
        return
    _set_recorded_offset(serial, current)
    logger.info("Schedule of %s kept at its local time after a DST switch (UTC offset %d -> %d min)", serial, recorded, current)


# ---- which clock the robot runs on ------------------------------------------------------------------
def _week_min(when: datetime) -> int:
    """Minutes since Sunday 00:00 (the robot's day 0)."""
    return ((when.weekday() + 1) % 7) * 24 * 60 + when.hour * 60 + when.minute


def _robot_offsets(events: list[dict], start: datetime) -> set[int]:
    """The offsets from UTC (min) under which `start` (a run start) falls on one of the events."""
    start_min = _week_min(start.astimezone(timezone.utc))
    found = set()
    for e in events:
        try:
            h, m = map(int, e["startTime"].split(":"))
            event_min = int(e["day"]) * 24 * 60 + h * 60 + m
        except (KeyError, ValueError, TypeError):
            continue
        # the run starts 0..START_LATE_MIN after the event: offset in [diff, diff + late]
        diff = (event_min - start_min + WEEK_MIN // 2) % WEEK_MIN - WEEK_MIN // 2
        offset = -(-diff // OFFSET_STEP_MIN) * OFFSET_STEP_MIN  # the step at or above diff
        if offset - diff <= START_LATE_MIN and MIN_OFFSET <= offset <= MAX_OFFSET:
            found.add(offset)
    return found


def check_clock(serial: str, run: dict) -> None:
    """After a scheduled run: which clock did the robot start it by? On a change the robot's
    events are moved so they keep their local time."""
    if run.get("launched_from") != "schedule":
        return
    try:
        start = datetime.fromisoformat(run["start_at"].replace("Z", "+00:00"))
    except (KeyError, ValueError, AttributeError):
        return
    reply = ask(serial, {"cmd": "getSchedule"})
    events = ((reply or {}).get("data") or {}).get("events") or []
    offsets = _robot_offsets(events, start)
    if len(offsets) != 1:
        return  # no event or several fit: nothing to learn from this run
    offset = offsets.pop()
    learned: Clock = LOCAL if offset == utc_offset_minutes() else offset
    current = clock(serial)
    shift = _to_local(current) - _to_local(learned)
    if shift == 0:
        return  # the current clock explains the run (also where local time and the offset agree)
    # the events were written for the other clock: move them so they keep their local time
    if ask(serial, {"cmd": "setSchedule", "params": {"events": _writable(shift_events(events, shift))}}) is None:
        return
    _set_clock(serial, learned)
    if learned != LOCAL:
        _set_recorded_offset(serial, utc_offset_minutes())
    logger.warning("Robot %s runs its schedule on %s, not %s: switched and moved its events",
                   serial, _clock_code(learned), _clock_code(current))
    notifications.add(serial, "schedule_clock", _clock_code(learned))


def _check_all() -> None:
    for serial, conn in list(robot_connections.items()):
        if isinstance(conn.conn, Gen2Gen3Conn):
            try:
                _follow_dst(serial)
            except Exception:
                logger.exception("Failed to move the schedule of %s for DST", serial)
    timer = threading.Timer(DST_CHECK_S, _check_all)
    timer.daemon = True
    timer.start()


def start() -> None:
    _check_all()
