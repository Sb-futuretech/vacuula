from __future__ import annotations
import hmac
import hashlib
from datetime import datetime, timezone
import logging
from vacuula_server.db import get_session
from vacuula_server.generation import get_robot_by_serial, get_gen3_robot_data
import json
import threading
import time

logger = logging.getLogger(__name__)

def hmac_sha256(message: str, secret: str) -> str:
    signature = hmac.new(
        secret.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    return signature


def rfc822_date() -> str:
    # Format like: Tue, 04 Dec 2025 19:55:03 GMT
    return datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")


def sign_cmd(robot_serial: str, cmd: str):
    date = rfc822_date()

    gen3_data = get_gen3_robot_data(robot_serial)
    if not gen3_data:
        logger.error("Gen3 data not found for serial %s", robot_serial)
        return ""
    password = gen3_data.password

    if not password:
        logger.warning("No password found for robot %s, using empty string", robot_serial)
        password = ""

    payload = (
        robot_serial.lower() + "\n" +
        date + "\n" +
        cmd
    )

    signature = hmac_sha256(payload, password).lower()

    return date + "|" + signature + "\r\n" + cmd


req_id = 1
# Commands come from several HTTP threads at once: without these, two sends can
# share a reqId or interleave their bytes on the robot's TLS socket, and the
# robot drops the connection.
_req_id_lock = threading.Lock()
_send_lock = threading.Lock()

def send_chunk(wfile, payload_bytes):
    chunk = f"{len(payload_bytes):X}\r\n".encode() + payload_bytes + b"\r\n"
    with _send_lock:
        wfile.write(chunk)
        wfile.flush()


def build_heartbeat():
    return json.dumps({
        "heartbeat": 60,
        "epoch": int(time.time())
    }).encode()


def build_command(robot_serial: str, cmd: dict):
    global req_id

    with _req_id_lock:
        this_id = req_id
        req_id += 1

    payload = json.dumps({
        "reqId": str(this_id),
        **cmd
    }, ensure_ascii=False)

    return [this_id, sign_cmd(robot_serial, payload).encode()]


def send_command(wfile, robot_serial: str, cmd: dict, slot) -> str:
    """Register `slot` for the reply and send `cmd`; returns the reqId key.
    On a send failure the slot is unregistered again and the error re-raised."""
    from vacuula_server.state import pending_requests

    req_id, msg = build_command(robot_serial, cmd)
    key = str(req_id)
    pending_requests[key] = slot
    try:
        send_chunk(wfile, msg)
    except Exception:
        pending_requests.pop(key, None)
        raise
    return key


def ask(robot_serial: str, cmd: dict, timeout: float = 15) -> dict | None:
    """Send `cmd` from the server itself and wait for the reply; None if the robot is not connected,
    does not answer in time or refuses the command."""
    from vacuula_server.conn import Gen2Gen3Conn
    from vacuula_server.state import PendingRequest, pending_requests, robot_connections

    conn = robot_connections.get(robot_serial)
    if conn is None or not isinstance(conn.conn, Gen2Gen3Conn):
        return None
    slot = PendingRequest()
    key = send_command(conn.conn.wfile, robot_serial, cmd, slot)
    slot.event.wait(timeout)
    pending_requests.pop(key, None)
    if not slot.event.is_set() or slot.status != 200:
        return None
    try:
        return json.loads(slot.content)
    except ValueError:
        return None
