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


class PendingRequest:
    __slots__ = ("event", "content", "status")

    def __init__(self):
        self.event = threading.Event()
        self.content = None
        self.status = None

    def fulfill(self, content, status):
        self.content = content
        self.status = status
        self.event.set()

# pending_requests:
# - req_id --> PendingRequest
pending_requests: dict[str, PendingRequest] = {}

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
