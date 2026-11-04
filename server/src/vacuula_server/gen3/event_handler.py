from __future__ import annotations
import logging
from vacuula_server import state
import json
import time
from vacuula_server.state import pending_requests, put_drop_oldest
from vacuula_server.gen3 import zone_queue, run_zone, run_segments
from vacuula_server import notifications
import typing

logger = logging.getLogger(__name__)

# modules told about every robot state, in this order
STATE_LISTENERS = (zone_queue, notifications, run_zone, run_segments)

def robot_message(serial: str, data: bytes):
    """Handle one whole message from the robot (see gen3.chunked): a heartbeat or a JSON object."""
    data = data.strip()
    if not data.startswith(b'{'):
        logger.debug("heartbeat from robot %s", serial)
        return

    try:
        decoded = json.loads(data.decode())
    except Exception as e:
        logger.error("failed to parse JSON from %s: %s", serial, e)
        return
    if not isinstance(decoded, dict):
        logger.warning("unexpected message from %s, ignored: %.200s", serial, data)
        return

    eventId = decoded.get("eventId")
    reqId = decoded.get("reqId")

    logger.debug("robot_data: serial=%s eventId=%s reqId=%s data=%s", serial, eventId, reqId, data)

    # state comes at the top level of command replies and under `data` in state events
    robot_state = (decoded.get("data") or {}) if decoded.get("type") == "state" else decoded if "state" in decoded else None
    if robot_state is not None:
        for listener in STATE_LISTENERS:
            listener.on_state(serial, robot_state)

    if reqId in pending_requests:
        slot = pending_requests.get(reqId)
        result = decoded.get("result")
        if slot is not None:
            slot.fulfill(data, 200 if result == "ok" else 400)
    elif eventId:
        clients = [c for c in state.client_connections if c["serial"] == serial]
        if clients:  # skip serializing when nobody is listening
            msg = json.dumps({
                "serial": serial,
                "event": eventId,
                "data": decoded,      # parsed dict, not raw bytes
                "ts": time.time(),
            }) + "\n"
            frame = f"data: {msg}\n\n".encode()
            for client in clients:
                put_drop_oldest(client["queue"], frame)


    else:
        logger.error("no eventId or reqId in data from %s", serial)
