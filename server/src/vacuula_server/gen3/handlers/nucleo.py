from __future__ import annotations
import logging
import socket
import time
from vacuula_server.gen3.commands import send_chunk, build_heartbeat
from vacuula_server.state import robot_connections, disconnected_at
from vacuula_server.handlers.events import notify_robots_changed
from vacuula_server.gen3.utils import get_robot_serial
from vacuula_server.db import get_session
from vacuula_server.gen3.event_handler import robot_data
from vacuula_server.models.robot import Robot
from sqlalchemy import select
from typing import TYPE_CHECKING
from vacuula_server.generation import get_gen3_robot_data, get_robot_by_serial, Generation
from vacuula_server.conn import RobotConn, Gen2Gen3Conn
if TYPE_CHECKING:
    from vacuula_server.handlers.router import RouterHandler

from vacuula_server import notifications
logger = logging.getLogger(__name__)

def nucleo_init(req: RouterHandler) -> None:
    """POST /vendors/neato/login - robot commands"""
    if not (serial := get_robot_serial(req)): return

    if not (gen3_data := get_gen3_robot_data(serial)):
        req.send_not_found("Robot not found")
        return

    sock = req.connection
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    if hasattr(socket, "TCP_USER_TIMEOUT"):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_USER_TIMEOUT, 20_000)
    sock.settimeout(60)

    req.send_response(200)
    req.send_header("Transfer-Encoding", "chunked")
    req.send_header("Connection", "close")
    req.end_headers()

    send_chunk(req.wfile, build_heartbeat())
    conn = RobotConn(serial, Generation.GEN3, Gen2Gen3Conn(gen3_data.password, req.wfile))
    peer = "%s:%s" % req.client_address[:2]
    if serial in robot_connections:
        logger.warning("Robot %s opened a new command connection while the old one was still open", serial)
    gone = disconnected_at.pop(serial, None)
    robot_connections[serial] = conn
    logger.info("Robot %s connected from %s%s", serial, peer, f" after {(time.time() - gone) / 60:.0f} min away" if gone else "")
    notify_robots_changed()
    notifications.robot_connected(serial)

    connected_at = last_data = time.time()
    reason = "closed by the robot"
    try:
        while True:
            data = req.rfile.readline()
            if not data:
                break
            last_data = time.time()
            robot_data(serial, data)
    except TimeoutError:
        reason = f"nothing received for {sock.gettimeout():.0f} s"
    except Exception as e:
        reason = f"{type(e).__name__}: {e}"
        logger.debug("Command connection of %s failed", serial, exc_info=True)
    finally:
        now = time.time()
        if robot_connections.get(serial) is conn:
            del robot_connections[serial]
            disconnected_at[serial] = now
            logger.info("Robot %s disconnected (%s) after %.0f min connected, last data %.0f s ago",
                        serial, reason, (now - connected_at) / 60, now - last_data)
            notify_robots_changed()
            notifications.robot_disconnected(serial)
        else:
            logger.info("Old command connection of %s ended (%s), already replaced", serial, reason)
