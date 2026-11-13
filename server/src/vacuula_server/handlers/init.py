from __future__ import annotations
import logging
from vacuula_server.handlers.router import RouterHandler
import threading

from vacuula_server.env import HOST_IP, ROBOT_PORTS, VACUULA_PORT
from vacuula_server.logger import LoggingThreadingHTTPServer

logger = logging.getLogger(__name__)

def start():
    # Vacuula server on vacuula port
    http_server = LoggingThreadingHTTPServer((HOST_IP, VACUULA_PORT), RouterHandler)
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()

    logger.info("Vacuula Server listening on http://%s:%d", HOST_IP, VACUULA_PORT)

    # one robot per extra port: the app there sees and controls only that robot
    for port, serial in ROBOT_PORTS.items():
        handler = type(f"RouterHandler_{port}", (RouterHandler,), {"only_serial": serial})
        server = LoggingThreadingHTTPServer((HOST_IP, port), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        logger.info("Vacuula Server for robot %s only listening on http://%s:%d", serial, HOST_IP, port)


