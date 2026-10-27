
from __future__ import annotations
import logging
import time
import typing
from vacuula_server.state import robot_connections, disconnected_at
if typing.TYPE_CHECKING:
    from vacuula_server.handlers.router import RouterHandler

logger = logging.getLogger(__name__)

def extract_robot_serial(auth_header: str) -> str:
    """Extract robot ID from Authorization header"""
    if not auth_header.startswith("NEATOBOT "):
        return ""
    token = auth_header[len("NEATOBOT "):]
    parts = token.split(":")
    if len(parts) < 2:
        return ""
    return parts[0]

def get_robot_serial(req: RouterHandler):
    serial = extract_robot_serial(req.headers.get("Authorization", ""))
    if not serial:
        req.send_bad_request("No robot serial")
        return None
    if serial not in robot_connections and req.path != "/vendors/neato/login":
        # the robot reaches the server but does not hold its command connection
        gone = disconnected_at.get(serial)
        logger.warning("Robot %s sent %s %s without a command connection (gone for %s)", serial, req.command, req.path,
                       f"{(time.time() - gone) / 60:.0f} min" if gone else "unknown")
    return serial

