"""Which clock a gen3 robot runs its schedule on - observed only, nothing is converted.

Schedule times go to the robot as the app sends them, taken as local time. The installer gives the
robot only a winter and a summer offset ("UTC+1:00UTC+2:00"), and the robot appears to switch
between them on other dates than the server (US rules?). Until that is known, every scheduled run
is compared with the robot's events and the offset it implies is logged.
"""
from __future__ import annotations
import logging

from datetime import datetime, timezone

from vacuula_server.gen3.commands import ask
from vacuula_server.server_tz import utc_offset_minutes

logger = logging.getLogger(__name__)

WEEK_MIN = 7 * 24 * 60
# a scheduled run starts this many minutes after its event at most
START_LATE_MIN = 5
# robot clocks are whole quarter hours off UTC, within the range real timezones use
OFFSET_STEP_MIN = 15
MIN_OFFSET, MAX_OFFSET = -12 * 60, 14 * 60


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
    """After a scheduled run: log the robot's clock offset it implies, and whether it is the server's."""
    if run.get("launched_from") != "schedule":
        return
    try:
        start = datetime.fromisoformat(run["start_at"].replace("Z", "+00:00"))
    except (KeyError, ValueError, AttributeError):
        return
    reply = ask(serial, {"cmd": "getSchedule"})
    events = ((reply or {}).get("data") or {}).get("events") or []
    offsets, local = sorted(_robot_offsets(events, start)), utc_offset_minutes()
    if offsets == [local]:
        logger.info("Scheduled run of %s at %s: robot clock is local time (UTC%+d min)", serial, run["start_at"], local)
    else:
        logger.warning("Scheduled run of %s at %s: robot clock UTC%s min, server UTC%+d min, events %s", serial,
                       run["start_at"], "/".join(f"{o:+d}" for o in offsets) or " unknown", local, events)
