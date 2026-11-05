"""Clean several Gen3 zones one after another.

The D7 answers `ok` to a startCleaning with `boundaryIds`, but ignores the list and
cleans the whole map. Only a single `boundaryId` per run works, so the server keeps
the remaining zones here and starts the next one once the robot reports it is back
idle on its dock.

A zone the robot cannot do (e.g. `nav_floorplan_zone_unreachable`) is not an error:
the robot sets `alert`, drives home and goes idle. That zone is recorded as failed and
the queue moves on.

Every change of the queue is pushed to the app as a `zoneQueue` event (see _broadcast).
"""
from __future__ import annotations
import json
import logging
import threading
import time
from dataclasses import dataclass, field

from vacuula_server.gen3.commands import gen3_wfile, send_and_wait
from vacuula_server.gen3.protocol import CATEGORY_MAP, STATE_BUSY, STATE_ERROR, STATE_IDLE
from vacuula_server.state import CONNECTION_LOST, push_to_app

logger = logging.getLogger(__name__)

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
    alert: str | None = None        # alert raised while the current zone was running
    stale_alert: str | None = None  # alert already set when the current zone started
    results: list[dict] = field(default_factory=list)  # finished zones: name + alert
    skipped: bool = False    # the remaining zones were dropped; the current one still runs

    def status(self, done: bool = False) -> dict:
        return {
            "index": self.index,
            "total": len(self.zones),
            "zones": [{"mapId": z.map_id, "boundaryId": z.boundary_id, "name": z.name} for z in self.zones],
            "results": self.results,
            "waiting": self.starting,  # between two zones, next one starts shortly
            "skipped": self.skipped,   # the zones after the current one were dropped
            "done": done,              # last status of a finished queue
        }


# serial --> queue
_queues: dict[str, ZoneQueue] = {}
_lock = threading.Lock()


def get_status(serial: str) -> dict | None:
    with _lock:
        q = _queues.get(serial)
        return q.status() if q else None


def _broadcast(serial: str, status: dict | None) -> None:
    """Push the queue status to the app's event stream; None = the queue was cancelled."""
    push_to_app(serial, "zoneQueue", status)


def cancel(serial: str, reason: str) -> None:
    with _lock:
        q = _queues.pop(serial, None)
    if q:
        _broadcast(serial, None)
        logger.info("Zone queue for %s cancelled at zone %d/%d: %s", serial, q.index + 1, len(q.zones), reason)


def skip(serial: str) -> None:
    """Drop the zones not started yet. A running zone is finished first, so the app can still show it."""
    with _lock:
        q = _queues.get(serial)
        if q is None:
            return
        q.skipped = True
        if q.starting:  # between two zones: nothing runs any more
            _queues.pop(serial, None)
        status = q.status(done=q.starting)
    _broadcast(serial, status)
    logger.info("Zone queue for %s: zones after %d/%d skipped from the app", serial, q.index + 1, len(q.zones))


def start(serial: str, zones: list[Zone], mode: int, navigation_mode: int) -> tuple[bool, str]:
    """Start the first zone; the rest follow from on_state(). Blocks until the robot answers."""
    q = ZoneQueue(zones=zones, mode=mode, navigation_mode=navigation_mode)
    with _lock:
        _queues[serial] = q
    ok, msg = _start_zone(serial, q)
    if ok:
        _broadcast(serial, get_status(serial))
    else:
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

        alert = data.get("alert")
        if alert and alert != q.stale_alert and (q.seen_busy or robot_state == STATE_BUSY):
            q.alert = alert

        if robot_state == STATE_ERROR or data.get("error"):
            reason = f"robot error {data.get('error')}"
        elif robot_state == STATE_BUSY:
            q.seen_busy = True
            return
        elif robot_state != STATE_IDLE or not q.seen_busy:
            return  # paused, or the start has not taken effect yet
        elif not (data.get("details") or {}).get("isDocked"):
            if q.index + 1 < len(q.zones):
                reason = "robot stopped away from the dock"
            else:  # the last zone is done, the robot just did not get back onto its base (notifications says so)
                _finish_zone(serial, q)
                _queues.pop(serial, None)
                _broadcast(serial, q.status(done=True))
                logger.info("Zone queue for %s finished %d of %d zones; the robot stopped away from its base",
                            serial, len(q.results), len(q.zones))
                return
        else:
            _finish_zone(serial, q)
            if q.skipped or q.index + 1 >= len(q.zones):
                _queues.pop(serial, None)
                _broadcast(serial, q.status(done=True))
                failed = sum(1 for r in q.results if r["alert"])
                logger.info("Zone queue for %s finished %d of %d zones (%d with alerts)", serial, len(q.results), len(q.zones), failed)
                return
            q.index += 1
            q.seen_busy = False
            q.alert = None
            q.starting = True
            _broadcast(serial, q.status())
            logger.info("Zone queue for %s: zone done, next zone %d/%d in %ds", serial, q.index + 1, len(q.zones), NEXT_ZONE_DELAY_S)
            # not on this thread: it is the robot's reader, which has to deliver the reply
            threading.Thread(target=_start_next, args=(serial, q), daemon=True).start()
            return

    cancel(serial, reason)


def _finish_zone(serial: str, q: ZoneQueue) -> None:
    zone = q.zones[q.index]
    q.results.append({"boundaryId": zone.boundary_id, "name": zone.name, "alert": q.alert})
    if q.alert:
        logger.warning("Zone queue for %s: zone %d/%d %r ended with alert %s", serial, q.index + 1, len(q.zones), zone.name or zone.boundary_id, q.alert)


def _start_next(serial: str, q: ZoneQueue) -> None:
    time.sleep(NEXT_ZONE_DELAY_S)
    with _lock:
        if _queues.get(serial) is not q:
            return  # cancelled while waiting
    ok, msg = _start_zone(serial, q)
    with _lock:
        q.starting = False
    if ok:
        _broadcast(serial, get_status(serial))
    else:
        cancel(serial, msg)


def _start_zone(serial: str, q: ZoneQueue) -> tuple[bool, str]:
    zone = q.zones[q.index]
    wfile = gen3_wfile(serial)
    if wfile is None:
        return False, "robot not connected"

    cmd = {
        "cmd": "startCleaning",
        "params": {
            "category": CATEGORY_MAP,
            "mode": q.mode,
            "navigationMode": q.navigation_mode,
            "mapId": zone.map_id,
            "boundaryId": zone.boundary_id,
        },
    }
    logger.info("Zone queue for %s: starting zone %d/%d %r", serial, q.index + 1, len(q.zones), zone.name or zone.boundary_id)
    try:
        slot = send_and_wait(wfile, serial, cmd, COMMAND_TIMEOUT_S)
    except Exception as e:
        return False, f"failed to send startCleaning: {e}"

    if not slot.event.is_set():
        return False, "robot did not answer startCleaning"
    if slot.status == CONNECTION_LOST:
        return False, "robot not connected"
    try:
        reply = json.loads(slot.content)
    except Exception:
        reply = {}
    if slot.status != 200:
        return False, f"robot refused startCleaning: {reply.get('result', slot.content)}"
    # a leftover alert from an earlier run stays in every state until cleared; do not blame this zone for it
    with _lock:
        q.stale_alert = reply.get("alert")
        if q.alert == q.stale_alert:
            q.alert = None  # on_state already saw the reply
    return True, "ok"
