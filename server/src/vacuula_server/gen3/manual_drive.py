"""Drive a Gen3 robot by hand ("Manual Drive" in the old Neato app).

getRobotManualCleaningInfo puts the robot into manual mode and returns its LAN address.
The robot then accepts a WebSocket at ws://<ip>:<port>/drive, signed like a command
(HMAC over serial and date, empty body). Browsers cannot set that Authorization header,
so the server holds the connection and the app sends its commands through it.

Messages are {"combo": ...} to move and {"command": ...} to switch the motors. A moving
combo has to be repeated: the app resends it while a button is held, and when that stops
(button released, app closed, connection lost) the server sends `stop` itself.
"""
from __future__ import annotations
import base64
import hashlib
import json
import logging
import os
import socket
import threading
import time
from dataclasses import dataclass, field

from vacuula_server.conn import Gen2Gen3Conn
from vacuula_server.gen3.commands import send_command, hmac_sha256, rfc822_date
from vacuula_server.generation import get_gen3_robot_data
from vacuula_server.state import robot_connections, pending_requests, PendingRequest

logger = logging.getLogger(__name__)

COMBOS = {"forward", "back", "stop", "arc-left", "arc-right", "pivot-left", "pivot-right"}
COMMANDS = {"vacuum-on", "vacuum-off", "brush-on", "brush-off", "eco-on", "eco-off", "turbo-on", "turbo-off"}

# a moving combo that is not repeated within this time is followed by `stop`
MOVE_TIMEOUT_S = 1.0
# no command at all for this long ends the session (the robot leaves manual mode after 30 s)
IDLE_TIMEOUT_S = 25
COMMAND_TIMEOUT_S = 30
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


@dataclass
class DriveSession:
    sock: socket.socket
    lock: threading.Lock = field(default_factory=threading.Lock)
    moving: bool = False
    last_move: float = field(default_factory=time.monotonic)
    last_command: float = field(default_factory=time.monotonic)
    closed: bool = False

    def send_frame(self, opcode: int, payload: bytes) -> None:
        """Masked client frame; our payloads stay below 126 bytes."""
        mask = os.urandom(4)
        frame = bytes([0x80 | opcode, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self.lock:
            self.sock.sendall(frame)

    def send(self, message: dict) -> None:
        self.send_frame(0x1, json.dumps(message).encode())


# serial --> session
_sessions: dict[str, DriveSession] = {}
_sessions_lock = threading.Lock()


def start(serial: str) -> tuple[bool, str]:
    """Put the robot into manual mode and connect to it. Blocks until connected or failed."""
    stop(serial)
    conn = robot_connections.get(serial)
    if conn is None or not isinstance(conn.conn, Gen2Gen3Conn):
        return False, "robot not connected"

    slot = PendingRequest()
    try:
        key = send_command(conn.conn.wfile, serial, {"cmd": "getRobotManualCleaningInfo"}, slot)
    except Exception as e:
        return False, f"failed to send getRobotManualCleaningInfo: {e}"
    slot.event.wait(COMMAND_TIMEOUT_S)
    pending_requests.pop(key, None)
    if not slot.event.is_set():
        return False, "robot did not answer getRobotManualCleaningInfo"
    reply = json.loads(slot.content)
    if slot.status != 200:
        return False, f"robot refused manual mode: {reply.get('result')}"

    data = reply.get("data") or {}
    if not data.get("ip_address") or not data.get("port"):
        return False, "robot sent no address for manual mode"
    try:
        sock = _connect(serial, data["ip_address"], int(data["port"]))
    except (OSError, ValueError) as e:
        return False, f"could not connect to the robot: {e}"

    session = DriveSession(sock)
    with _sessions_lock:
        _sessions[serial] = session
    threading.Thread(target=_reader, args=(serial, session), daemon=True).start()
    threading.Thread(target=_watchdog, args=(serial, session), daemon=True).start()
    logger.info("Manual drive for %s connected to %s:%s", serial, data["ip_address"], data["port"])
    return True, "ok"


def send(serial: str, message: dict) -> tuple[int, str]:
    """Forward {"combo": ...} or {"command": ...} to the robot; returns an HTTP status."""
    combo, command = message.get("combo"), message.get("command")
    if combo not in COMBOS and command not in COMMANDS:
        return 400, f"unknown combo/command, allowed: {sorted(COMBOS | COMMANDS)}"
    with _sessions_lock:
        session = _sessions.get(serial)
    if session is None:
        return 409, "manual drive is not started"

    try:
        session.send({"combo": combo} if combo in COMBOS else {"command": command})
    except OSError:
        _close(serial, session, "send failed")
        return 502, "connection to the robot lost"
    now = time.monotonic()
    session.last_command = now
    if combo in COMBOS:
        session.moving = combo != "stop"
        session.last_move = now
    return 200, "ok"


def stop(serial: str) -> None:
    with _sessions_lock:
        session = _sessions.get(serial)
    if session:
        _close(serial, session, "stopped from the app")


def _connect(serial: str, ip: str, port: int) -> socket.socket:
    gen3_data = get_gen3_robot_data(serial)
    if gen3_data is None:
        raise ValueError("no gen3 data for this robot")
    date = rfc822_date()
    key = base64.b64encode(os.urandom(16)).decode()
    signature = hmac_sha256(serial.lower() + "\n" + date + "\n", gen3_data.password or "")
    sock = socket.create_connection((ip, port), timeout=5)
    sock.sendall((
        f"GET /drive HTTP/1.1\r\nHost: {ip}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ws://{ip}:{port}/drive\r\n"
        f"Date: {date}\r\nAuthorization: NEATOAPP {signature}\r\n\r\n"
    ).encode())

    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(1024)
        if not chunk:
            sock.close()
            raise ConnectionError("robot closed the connection during the login")
        head += chunk
    status = head.split(b"\r\n", 1)[0].decode(errors="replace")
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest())
    if not status.startswith("HTTP/1.1 101") or accept not in head:
        sock.close()
        raise ConnectionError(f"robot refused the login: {status}")
    sock.settimeout(None)
    return sock


def _recv_exact(sock: socket.socket, size: int) -> bytes:
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
    return data


def _reader(serial: str, session: DriveSession) -> None:
    """Answers pings and notices when the robot closes the connection; robot messages are only logged."""
    try:
        while True:
            head = _recv_exact(session.sock, 2)
            opcode, length = head[0] & 0x0F, head[1] & 0x7F
            if length == 126:
                length = int.from_bytes(_recv_exact(session.sock, 2), "big")
            elif length == 127:
                length = int.from_bytes(_recv_exact(session.sock, 8), "big")
            payload = _recv_exact(session.sock, length)  # frames from the robot are not masked
            if opcode == 0x8:
                break
            if opcode == 0x9:
                session.send_frame(0xA, payload)
            elif payload:
                logger.debug("Manual drive message from %s: %s", serial, payload)
    except OSError:
        pass
    _close(serial, session, "connection closed by the robot")


def _watchdog(serial: str, session: DriveSession) -> None:
    while not session.closed:
        time.sleep(0.2)
        now = time.monotonic()
        try:
            if session.moving and now - session.last_move > MOVE_TIMEOUT_S:
                session.moving = False
                session.send({"combo": "stop"})
        except OSError:
            _close(serial, session, "send failed")
            return
        if now - session.last_command > IDLE_TIMEOUT_S:
            _close(serial, session, "no command for %ds" % IDLE_TIMEOUT_S)
            return


def _close(serial: str, session: DriveSession, reason: str) -> None:
    with _sessions_lock:
        if session.closed:
            return
        session.closed = True
        if _sessions.get(serial) is session:
            del _sessions[serial]
    try:
        session.send({"combo": "stop"})
        session.send_frame(0x8, (1000).to_bytes(2, "big"))
    except OSError:
        pass
    session.sock.close()
    logger.info("Manual drive for %s ended: %s", serial, reason)
