"""Clean several Gen3 zones one after another.

The D7 answers `ok` to a startCleaning with `boundaryIds`, but ignores the list and
cleans the whole map. Only a single `boundaryId` per run works, so the server keeps
the remaining zones here and starts the next one once the robot reports it is back
idle on its dock.
"""
from __future__ import annotations
import json
import logging
import threading
import time
from dataclasses import dataclass, field

from vacuula_server.conn import Gen2Gen3Conn
from vacuula_server.gen3.commands import send_command
from vacuula_server.state import robot_connections, pending_requests, PendingRequest

logger = logging.getLogger(__name__)

# Gen3 robot `state` values
STATE_IDLE = 1
STATE_BUSY = 2
STATE_ERROR = 4

# Commands from the app that mean the user took over; they end the queue
CANCELLING_COMMANDS = {"startCleaning", "stopCleaning", "sendToBase"}

# Give the robot time to settle on the dock (and upload its run map) before the next zone
NEXT_ZONE_DELAY_S = 15
COMMAND_TIMEOUT_S = 30


@dataclass
class Zone:
    map_id: str
    boundary_id: str
    name: str = ""


@dataclass
class ZoneQueue:
    zones: list[Zone]
    mode: int
    navigation_mode: int
    index: int = 0          # zone currently being cleaned
    seen_busy: bool = False  # robot reported busy since the current zone was started
    starting: bool = False   # a start for the next zone is pending
    started_at: float = field(default_factory=time.time)

    def status(self) -> dict:
        return {
            "index": self.index,
            "total": len(self.zones),
            "zones": [{"mapId": z.map_id, "boundaryId": z.boundary_id, "name": z.name} for z in self.zones],
            "mode": self.mode,
            "navigationMode": self.navigation_mode,
            "startedAt": self.started_at,
        }


# serial --> queue
_queues: dict[str, ZoneQueue] = {}
_lock = threading.Lock()


def get_status(serial: str) -> dict | None:
    with _lock:
        q = _queues.get(serial)
        return q.status() if q else None


def cancel(serial: str, reason: str) -> None:
    with _lock:
        q = _queues.pop(serial, None)
    if q:
        logger.info("Zone queue for %s cancelled at zone %d/%d: %s", serial, q.index + 1, len(q.zones), reason)


def start(serial: str, zones: list[Zone], mode: int, navigation_mode: int) -> tuple[bool, str]:
    """Start the first zone; the rest follow from on_state(). Blocks until the robot answers."""
    q = ZoneQueue(zones=zones, mode=mode, navigation_mode=navigation_mode)
    with _lock:
        _queues[serial] = q
    ok, msg = _start_zone(serial, q)
    if not ok:
        cancel(serial, msg)
    return ok, msg


def on_state(serial: str, data: dict) -> None:
    """Feed every robot state (pushed events and command replies) in here."""
    robot_state = data.get("state")
    if robot_state is None:
        return

    with _lock:
        q = _queues.get(serial)
        if q is None or q.starting:
            return

        if robot_state == STATE_ERROR or data.get("error"):
            reason = f"robot error {data.get('error')}"
        elif robot_state == STATE_BUSY:
            q.seen_busy = True
            return
        elif robot_state != STATE_IDLE or not q.seen_busy:
            return  # paused, or the start has not taken effect yet
        elif not (data.get("details") or {}).get("isDocked"):
            reason = "robot stopped away from the dock"
        elif q.index + 1 >= len(q.zones):
            _queues.pop(serial, None)
            logger.info("Zone queue for %s finished all %d zones", serial, len(q.zones))
            return
        else:
            q.index += 1
            q.seen_busy = False
            q.starting = True
            logger.info("Zone queue for %s: zone done, next zone %d/%d in %ds", serial, q.index + 1, len(q.zones), NEXT_ZONE_DELAY_S)
            # not on this thread: it is the robot's reader, which has to deliver the reply
            threading.Thread(target=_start_next, args=(serial, q), daemon=True).start()
            return

    cancel(serial, reason)


def _start_next(serial: str, q: ZoneQueue) -> None:
    time.sleep(NEXT_ZONE_DELAY_S)
    with _lock:
        if _queues.get(serial) is not q:
            return  # cancelled while waiting
    ok, msg = _start_zone(serial, q)
    with _lock:
        q.starting = False
    if not ok:
        cancel(serial, msg)


def _start_zone(serial: str, q: ZoneQueue) -> tuple[bool, str]:
    zone = q.zones[q.index]
    conn = robot_connections.get(serial)
    if conn is None or not isinstance(conn.conn, Gen2Gen3Conn):
        return False, "robot not connected"

    cmd = {
        "cmd": "startCleaning",
        "params": {
            "category": 4,  # map
            "mode": q.mode,
            "navigationMode": q.navigation_mode,
            "mapId": zone.map_id,
            "boundaryId": zone.boundary_id,
        },
    }
    logger.info("Zone queue for %s: starting zone %d/%d %r", serial, q.index + 1, len(q.zones), zone.name or zone.boundary_id)
    slot = PendingRequest()
    try:
        key = send_command(conn.conn.wfile, serial, cmd, slot)
    except Exception as e:
        return False, f"failed to send startCleaning: {e}"

    slot.event.wait(COMMAND_TIMEOUT_S)
    pending_requests.pop(key, None)
    if not slot.event.is_set():
        return False, "robot did not answer startCleaning"
    if slot.status != 200:
        try:
            result = json.loads(slot.content).get("result")
        except Exception:
            result = slot.content
        return False, f"robot refused startCleaning: {result}"
    return True, "ok"
