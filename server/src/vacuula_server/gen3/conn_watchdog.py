"""Close a gen3 command connection whose robot no longer answers, so the robot connects again.

Seen on huugo (D7, 4.6.0) on 2026-11-15 after a zone save whose answer was too big: the robot kept
the connection open but sent nothing more and answered no command, for minutes, until the server
was restarted - then it connected again at once. The robot's own watchdog (installer) only acts
when it has no connection at all, and the server's read timeout did not end this one.

So: a robot that has answered nothing for STALE_S is asked for its state; after FAILS unanswered
asks in a row the server shuts the socket down. A robot that answers anything (a reply or an event)
counts as alive.
"""
from __future__ import annotations

import logging
import socket
import threading
import time

logger = logging.getLogger(__name__)

CHECK_S = 30      # how often to look
STALE_S = 120     # silent this long -> ask
ASK_TIMEOUT_S = 25
FAILS = 2         # unanswered asks in a row -> close

# serial -> time of the robot's last JSON message (reply or event) on its command connection
last_seen: dict[str, float] = {}
_fails: dict[str, int] = {}
_started = False


def seen(serial: str) -> None:
    last_seen[serial] = time.time()
    _fails.pop(serial, None)


def _check() -> None:
    from vacuula_server.conn import Gen2Gen3Conn
    from vacuula_server.gen3 import commands
    from vacuula_server.state import robot_connections

    now = time.time()
    for serial, conn in list(robot_connections.items()):
        if not isinstance(conn.conn, Gen2Gen3Conn):
            continue
        last = last_seen.setdefault(serial, now)
        if now - last < STALE_S:
            continue
        if commands.ask(serial, {"cmd": "getRobotState"}, timeout=ASK_TIMEOUT_S) is not None:
            continue  # answered: seen() was called on the way in
        if robot_connections.get(serial) is not conn:
            continue  # replaced meanwhile
        _fails[serial] = _fails.get(serial, 0) + 1
        logger.warning("Robot %s: no answer for %.0f s (try %d of %d)", serial, time.time() - last, _fails[serial], FAILS)
        if _fails[serial] >= FAILS:
            _fails.pop(serial, None)
            sock = getattr(conn.conn, "sock", None)
            logger.warning("Robot %s answers nothing: closing its command connection so it connects again", serial)
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError as e:
                    logger.info("Closing the connection of %s: %s", serial, e)


def _loop() -> None:
    while True:
        time.sleep(CHECK_S)
        try:
            _check()
        except Exception:
            logger.exception("Connection watchdog check failed")


def start() -> None:
    global _started
    if not _started:
        _started = True
        threading.Thread(target=_loop, name="gen3-conn-watchdog", daemon=True).start()
