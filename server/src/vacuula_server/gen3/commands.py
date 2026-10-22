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
    }).encode()

    return [this_id, sign_cmd(robot_serial, payload.decode()).encode()]