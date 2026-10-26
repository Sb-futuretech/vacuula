"""Schedule entries the server runs itself (gen3).

The robot's own schedule only keeps mode, day, time and one zone (see FORK.md). Entries with a
navigation mode (Extra Care, Deep) or several zones are kept here and started by the server: a whole
map without a map id (the robot finds its map), one zone directly, several zones through the zone
queue.

A robot schedule event within OVERLAP_MIN of a server entry is its fallback: just before its own
start the server switches the robot's schedule off, and on again shortly after, and notes it in the
notification centre. Without the server, the robot runs its own event as usual.
"""
from __future__ import annotations
import logging
import threading
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from vacuula_server import notifications
from vacuula_server.db import get_session
from vacuula_server.gen3 import zone_queue
from vacuula_server.gen3.commands import ask
from vacuula_server.gen3.data import Gen3Data, Gen3PiSchedule
from vacuula_server.gen3.schedule_tz import robot_to_local, shift_events
from vacuula_server.server_tz import server_timezone

logger = logging.getLogger(__name__)

CHECK_S = 20
PAUSE_BEFORE_S = 60    # the robot's own schedule is switched off this long before a start ...
RESUME_AFTER_S = 120   # ... and on again this long after it
START_WINDOW_S = 120   # a start missed by more than this (server was down) is not made up
OVERLAP_MIN = 15       # a robot event this close to a server entry is its fallback

MODE_ECO, NAV_DEEP = 1, 3
STATE_IDLE = 1


# ---- entries --------------------------------------------------------------------------------------
def _to_dict(e: Gen3PiSchedule) -> dict:
    return {"id": e.id, "days": e.days, "startTime": e.start_time, "mode": e.mode,
            "navigationMode": e.navigation_mode, "zones": e.zones, "enabled": e.enabled}


def entries(serial: str) -> list[dict]:
    with get_session() as session:
        rows = session.execute(select(Gen3PiSchedule).where(Gen3PiSchedule.robot == serial)).scalars().all()
        return [_to_dict(e) for e in rows]


def validate(data: dict) -> tuple[dict | None, str]:
    """The entry from an app request, or None and why it is not valid."""
    try:
        days = sorted({int(d) for d in data["days"]})
        h, m = map(int, str(data["startTime"]).split(":"))
        mode, nav = int(data["mode"]), int(data["navigationMode"])
        zones = [{"mapId": str(z["mapId"]), "boundaryId": str(z["boundaryId"]), "name": str(z.get("name") or "")}
                 for z in data.get("zones") or []]
        enabled = bool(data.get("enabled", True))
    except (KeyError, TypeError, ValueError):
        return None, "days, startTime (HH:MM), mode, navigationMode and zones ({mapId, boundaryId}) are required"
    if not days or any(d < 0 or d > 6 for d in days):
        return None, "days must be 0 (Sunday) .. 6"
    if not (0 <= h < 24 and 0 <= m < 60):
        return None, "startTime must be HH:MM"
    if mode not in (1, 2) or nav not in (1, 2, 3):
        return None, "mode must be 1 or 2, navigationMode 1, 2 or 3"
    if mode == MODE_ECO and nav == NAV_DEEP:
        return None, "the robot rejects Eco together with Deep"
    return {"days": days, "start_time": f"{h:02d}:{m:02d}", "mode": mode, "navigation_mode": nav, "zones": zones,
            "enabled": enabled}, "ok"


def add(serial: str, entry: dict) -> dict:
    with get_session() as session:
        row = Gen3PiSchedule(robot=serial, **entry)
        session.add(row)
        session.commit()
        return _to_dict(row)


def update(serial: str, entry_id: int, entry: dict) -> dict | None:
    with get_session() as session:
        row = session.get(Gen3PiSchedule, entry_id)
        if row is None or row.robot != serial:
            return None
        for k, v in entry.items():
            setattr(row, k, v)
        session.commit()
        return _to_dict(row)


def remove(serial: str, entry_id: int) -> bool:
    with get_session() as session:
        row = session.get(Gen3PiSchedule, entry_id)
        if row is None or row.robot != serial:
            return False
        session.delete(row)
        session.commit()
        return True


# ---- timing ---------------------------------------------------------------------------------------
def robot_day(d: date) -> int:
    """The robot's day number: 0 = Sunday."""
    return (d.weekday() + 1) % 7


def _starts_near(entry: Gen3PiSchedule, now: datetime) -> list[datetime]:
    """The entry's starts yesterday, today and tomorrow (local time)."""
    h, m = map(int, entry.start_time.split(":"))
    out = []
    for offset in (-1, 0, 1):
        day = now.date() + timedelta(days=offset)
        if robot_day(day) in entry.days:
            out.append(datetime(day.year, day.month, day.day, h, m, tzinfo=now.tzinfo))
    return out


def _overlapping_robot_events(serial: str, events: list[dict], start: datetime) -> list[str]:
    """Start times of the robot's own events (on the robot's clock) close to `start`."""
    minute = start.hour * 60 + start.minute
    found = []
    for e in shift_events(events, robot_to_local(serial)):
        try:
            h, m = map(int, e["startTime"].split(":"))
        except (KeyError, ValueError):
            continue
        if e.get("day") == robot_day(start.date()) and abs(h * 60 + m - minute) <= OVERLAP_MIN:
            found.append(e["startTime"])
    return found


# ---- actions --------------------------------------------------------------------------------------
def _set_paused_until(serial: str, until: int | None) -> None:
    with get_session() as session:
        if data := session.get(Gen3Data, serial):
            data.robot_schedule_paused_until = until
            session.commit()


def _pause_robot_schedule(entry: Gen3PiSchedule, start: datetime) -> None:
    serial = entry.robot
    with get_session() as session:
        data = session.get(Gen3Data, serial)
        if data is None or (data.robot_schedule_paused_until or 0) >= start.timestamp():
            return  # already paused for this start
    reply = ask(serial, {"cmd": "getSchedule"})
    schedule = (reply or {}).get("data") or {}
    if not schedule.get("enabled"):
        return
    overlapping = _overlapping_robot_events(serial, schedule.get("events") or [], start)
    if not overlapping or ask(serial, {"cmd": "disableSchedule"}) is None:
        return
    _set_paused_until(serial, int(start.timestamp()) + RESUME_AFTER_S)
    logger.info("Robot schedule of %s off around the server's %s start (robot events %s)", serial, entry.start_time, overlapping)
    notifications.add(serial, "schedule_overlap", data={"piTime": entry.start_time, "robotTimes": overlapping})


def _resume_robot_schedules(now: float) -> None:
    """Switch the robot's schedule on again once a pause is over (also after a server restart)."""
    with get_session() as session:
        due = session.execute(select(Gen3Data.robot).where(Gen3Data.robot_schedule_paused_until <= now)).scalars().all()
    for serial in due:
        if ask(serial, {"cmd": "enableSchedule"}) is not None:
            _set_paused_until(serial, None)
            logger.info("Robot schedule of %s on again", serial)


def _start(entry: Gen3PiSchedule, start: datetime) -> None:
    serial = entry.robot
    with get_session() as session:
        if row := session.get(Gen3PiSchedule, entry.id):
            row.last_run_at = int(start.timestamp())  # first, so a failure is not retried every check
            session.commit()

    def skipped(reason: str) -> None:
        logger.warning("Server schedule %s of %s not started: %s", entry.start_time, serial, reason)
        notifications.add(serial, "schedule_skipped", reason, {"piTime": entry.start_time})

    state = ask(serial, {"cmd": "getRobotState"})
    if state is None:
        return skipped("robot_offline")
    if state.get("state") != STATE_IDLE or not (state.get("details") or {}).get("isDocked"):
        return skipped("robot_busy")

    zones = entry.zones or []
    logger.info("Server schedule %s of %s: starting, mode %d, navigation %d, %s", entry.start_time, serial,
                entry.mode, entry.navigation_mode, f"{len(zones)} zones" if zones else "whole map")
    if len(zones) > 1:
        ok, msg = zone_queue.start(serial, [zone_queue.Zone(z["mapId"], z["boundaryId"], z.get("name", "")) for z in zones],
                                   entry.mode, entry.navigation_mode)
        if not ok:
            skipped(msg)
        return
    params = {"category": 4, "mode": entry.mode, "navigationMode": entry.navigation_mode}
    if zones:
        params |= {"mapId": zones[0]["mapId"], "boundaryId": zones[0]["boundaryId"]}
    reply = ask(serial, {"cmd": "startCleaning", "params": params})
    if reply is None:
        skipped("refused")
    else:
        logger.info("Server schedule %s of %s: robot answered %s", entry.start_time, serial, reply.get("result"))


def check(now: datetime) -> None:
    """One pass over all entries at local time `now`: pause robot schedules, start what is due."""
    _resume_robot_schedules(now.timestamp())
    with get_session() as session:
        all_entries = session.execute(select(Gen3PiSchedule)).scalars().all()
        session.expunge_all()
    for entry in all_entries:
        if not entry.enabled:
            continue
        for start in _starts_near(entry, now):
            if start - timedelta(seconds=PAUSE_BEFORE_S) <= now < start:
                _pause_robot_schedule(entry, start)
            elif start <= now < start + timedelta(seconds=START_WINDOW_S) and (entry.last_run_at or 0) < start.timestamp():
                _start(entry, start)


def _tick() -> None:
    try:
        check(datetime.now(ZoneInfo(server_timezone())))
    except Exception:
        logger.exception("Server schedule check failed")
    timer = threading.Timer(CHECK_S, _tick)
    timer.daemon = True
    timer.start()


def start() -> None:
    _tick()
