"""Gen3 robots run their schedule in UTC: they take the time from NTP and have no timezone.

The app works in the server's local time, so `setSchedule` / `getSchedule` are converted on their
way through. The offset a schedule was written with is kept per robot; after a DST switch the
robot's events are shifted so they keep their local time.
"""
from __future__ import annotations
import json
import logging
import threading

from vacuula_server.conn import Gen2Gen3Conn
from vacuula_server.db import get_session
from vacuula_server.gen3.commands import send_command
from vacuula_server.gen3.data import Gen3Data
from vacuula_server.server_tz import utc_offset_minutes
from vacuula_server.state import PendingRequest, pending_requests, robot_connections

logger = logging.getLogger(__name__)

WEEK_MIN = 7 * 24 * 60
DST_CHECK_S = 10 * 60
COMMAND_TIMEOUT_S = 15


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


def _recorded_offset(serial: str) -> int | None:
    with get_session() as session:
        data = session.get(Gen3Data, serial)
        return data.schedule_utc_offset if data else None


# ---- app commands on their way through ---------------------------------------------------------
def to_robot(cmd: dict) -> dict:
    """setSchedule from the app (local time) -> robot (UTC)."""
    if cmd.get("cmd") != "setSchedule" or not isinstance(cmd.get("params", {}).get("events"), list):
        return cmd
    params = {**cmd["params"], "events": shift_events(cmd["params"]["events"], -utc_offset_minutes())}
    return {**cmd, "params": params}


def from_robot(serial: str, cmd: dict, content, status: int | None):
    """The robot's reply, with getSchedule events in local time; remembers the offset of a written schedule."""
    if status != 200 or cmd.get("cmd") not in ("setSchedule", "getSchedule"):
        return content
    offset = utc_offset_minutes()
    if cmd["cmd"] == "setSchedule":
        _set_recorded_offset(serial, offset)
        return content
    try:
        reply = json.loads(content)
        reply["data"]["events"] = shift_events(reply["data"]["events"], offset)
    except (ValueError, KeyError, TypeError):
        return content
    return json.dumps(reply).encode()


# ---- DST switch ---------------------------------------------------------------------------------
def _ask(serial: str, cmd: dict) -> dict | None:
    conn = robot_connections.get(serial)
    if conn is None or not isinstance(conn.conn, Gen2Gen3Conn):
        return None
    slot = PendingRequest()
    key = send_command(conn.conn.wfile, serial, cmd, slot)
    slot.event.wait(COMMAND_TIMEOUT_S)
    pending_requests.pop(key, None)
    if not slot.event.is_set() or slot.status != 200:
        return None
    return json.loads(slot.content)


def _follow_dst(serial: str) -> None:
    recorded, current = _recorded_offset(serial), utc_offset_minutes()
    if recorded is None or recorded == current:
        return
    reply = _ask(serial, {"cmd": "getSchedule"})
    if reply is None:
        return  # try again at the next check
    events = (reply.get("data") or {}).get("events") or []
    # setSchedule takes `boundaryId`; events read back carry `boundary` instead
    events = [{k: v for k, v in e.items() if k != "boundary"} | ({"boundaryId": e["boundary"]["id"]} if e.get("boundary") else {})
              for e in shift_events(events, recorded - current)]
    if _ask(serial, {"cmd": "setSchedule", "params": {"events": events}}) is None:
        return
    _set_recorded_offset(serial, current)
    logger.info("Schedule of %s kept at its local time after a DST switch (UTC offset %d -> %d min)", serial, recorded, current)


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
