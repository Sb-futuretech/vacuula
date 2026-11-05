from __future__ import annotations
from vacuula_server.conn import RobotConn
from typing import Dict
import json, threading, time, queue
from contextlib import suppress

# robot_connections: List[RobotConn]  = []
robot_connections: Dict[str, RobotConn] = {}
# serial -> when its command connection last ended (time.time()), to tell how long a robot was gone
disconnected_at: Dict[str, float] = {}


# client_connection:
# - client id
# - connection itself
client_connections = []


# status of a request whose connection ended before the robot answered
CONNECTION_LOST = 0


class PendingRequest:
    __slots__ = ("event", "content", "status", "wfile")

    def __init__(self):
        self.event = threading.Event()
        self.content = None
        self.status = None
        self.wfile = None  # the connection it was sent on (gen3)

    def fulfill(self, content, status):
        self.content = content
        self.status = status
        self.event.set()

# pending_requests:
# - req_id --> PendingRequest
pending_requests: dict[str, PendingRequest] = {}


def fail_pending(wfile) -> None:
    """The connection these requests went out on has ended: end their wait now, not at the timeout."""
    for slot in list(pending_requests.values()):
        if slot.wfile is wfile:
            slot.fulfill(None, CONNECTION_LOST)

def put_drop_oldest(q: queue.Queue, item: bytes) -> None:
    try:
        q.put_nowait(item)
    except queue.Full:
        with suppress(queue.Empty):
            q.get_nowait()
        with suppress(queue.Full):
            q.put_nowait(item)


def push_to_app(serial: str, event: str, data) -> None:
    """Send a server-side event (not from the robot) to every app connected to this robot."""
    clients = [c for c in client_connections if c["serial"] == serial]
    if not clients:
        return
    msg = json.dumps({"serial": serial, "event": event, "data": data, "ts": time.time()})
    frame = f"data: {msg}\n\n".encode()
    for client in clients:
        put_drop_oldest(client["queue"], frame)
