from __future__ import annotations
import logging
from vacuula_server.conn import Gen2Gen3Conn
from vacuula_server.gen3.commands import send_command
from vacuula_server.gen3 import zone_queue
from vacuula_server.env import GEN3_PORT, GEN4_PORT
from vacuula_server.constants import APP_VERSION, MAPS_DIR, MINIMUM_INSTALLER_VERSION
from vacuula_server.state import robot_connections, client_connections, pending_requests, PendingRequest
from vacuula_server.handlers.events import robots_snapshot, notify_robots_changed, CLIENT_QUEUE_MAX
from vacuula_server.db import get_session
from vacuula_server.models.persistent_map import FloorPlan, PersistentMap
from vacuula_server.models.robot import Robot
from vacuula_server.models.run import Gen4__Run, Gen3__Run
from sqlalchemy import select, update
from vacuula_server.generation import Generation, get_robot_by_serial
import json
import queue
import os
from vacuula_server.gen4.handlers import robot_send_request
from vacuula_server.server_tz import server_timezone, utc_offset_minutes

from typing import TYPE_CHECKING, Sequence
if TYPE_CHECKING:
    from vacuula_server.handlers.router import RouterHandler



# Longest wait for a robot to answer a command before the HTTP request fails
COMMAND_TIMEOUT_S = 30
logger = logging.getLogger(__name__)

def get_server_info(req: RouterHandler) -> None:
    """GET /server - static facts about this server the web app or installer needs."""
    tz = server_timezone()
    req.send_ok({
        "version": APP_VERSION,
        "min_installer_version": MINIMUM_INSTALLER_VERSION,
        "gen3_port": GEN3_PORT,
        "gen4_port": GEN4_PORT,
   
        "timezone": tz,
        "utc_offset_minutes": utc_offset_minutes(tz),
    })


def get_robots(req: RouterHandler) -> None:
    """GET /robots - list all robots with connection status (empty object when none)"""
    req.send_ok(robots_snapshot())


def get_maps(req: RouterHandler, serial: str) -> None:
    """GET /robot/<serial>/maps - list all maps to user"""

    table = PersistentMap if '-' in serial else FloorPlan

    with get_session() as session:
        maps: Sequence[PersistentMap | FloorPlan] = session.execute(
            select(table)
            .where(table.robot == serial, table.in_maps_list == True)

        ).scalars().all()

    data = [
        {
            column.name: getattr(x, column.name)
            for column in table.__table__.columns
        }
        for x in maps
    ]

    req.send_ok(data)


def get_map(req: RouterHandler, serial: str, map_id: str) -> None:
    """GET /robot/<serial>/maps/<map_id> - return map data to user"""
    file = MAPS_DIR / serial / str(map_id) / "floormap.json"

    table = PersistentMap if '-' in serial else FloorPlan

    with get_session() as session:
        floorplan = session.get(table, map_id)

    if not os.path.isfile(file):
        req.send_not_found("Map not found")
        return

    try:
        with open(file, 'r') as f:
            data = json.load(f)
    except Exception:
        req.send_internal_error("Failed to read map")
        return
    

    ## TODO: quickfix hack to get data to fe, rework later...
    if floorplan is None:
        req.send_not_found("Map not found")
        return
    elif floorplan is not None:
        data["in_maps_list"] = floorplan.in_maps_list
        data["base"] = floorplan.base

    req.send_ok(data)

def post_map(req: RouterHandler, serial: str, map_id: str) -> None:
    """POST /robot/<serial>/maps/<map_id> - update map data"""
    if not (data := req.read_json()): return

    name = data.get("name")
    enabled = data.get("enabled")

    if name is None or enabled is None:
        return req.send_bad_request("name and enabled are required")

    with get_session() as session:
        session.execute(
            update(PersistentMap)
            .where(PersistentMap.id == map_id, PersistentMap.robot == serial)
            .values(name=name, enabled=enabled)
        )

        session.execute(
            update(FloorPlan)
            .where(FloorPlan.id == map_id, FloorPlan.robot == serial)
            .values(name=name)
        )
        session.commit()
    
    req.send_ok()

def post_robot(req: RouterHandler, serial: str) -> None:
    """POST /robot/<serial> - update robot"""
    if not (data := req.read_json()): return

    name = data.get("name")

    if name is None:
        return req.send_bad_request("name is required")

    with get_session() as session:
        session.execute(
            update(Robot)
            .where(Robot.serial == serial)
            .values(name=name)
        )
        session.commit()

    notify_robots_changed()
    req.send_ok()

def get_runs(req: RouterHandler, serial: str) -> None:
    """GET /robot/<serial>/runs - list all runs to user"""

    table = Gen3__Run if '-' in serial else Gen4__Run

    with get_session() as session:
        runs = session.execute(
            select(table)
            .where(table.robot == serial)
        ).scalars().all()

    data = [
        {
            column.name: getattr(run, column.name)
            for column in table.__table__.columns
        }
        for run in runs
    ]

    req.send_ok(data)

def get_run(req: RouterHandler, serial: str, run_id: str) -> None:
    """GET /robot/<serial>/run/<run_id> - list all runs to user"""
    file = MAPS_DIR / serial / str(run_id) / "runmap.json"

    if not os.path.isfile(file):
        req.send_not_found("Map not found")
        return

    try:
        with open(file, 'r') as f:
            data = json.load(f)
    except Exception:
        req.send_internal_error("Failed to read map")
        return

    req.send_ok(data)






def connect_robot(req: RouterHandler, serial: str) -> None:
    """GET /robots/{serial}/connect - SSE stream for client"""
    if get_robot_by_serial(serial) is None:
        req.send_not_found("Robot not found")
        return

    req.send_response(200)
    req.send_header("Content-Type", "text/event-stream")
    req.send_header("Cache-Control", "no-cache")
    req.send_header("Connection", "keep-alive")
    req.end_headers()

    q: queue.Queue = queue.Queue(maxsize=CLIENT_QUEUE_MAX)
    conn = {"client": "test", "serial": serial, "queue": q}
    client_connections.append(conn)

    try:
        req.wfile.write(b": keepalive\n\n")
        req.wfile.flush()
        while True:
            # Heartbeat every 15 seconds
            try:
                frame = q.get(timeout=15)
            except queue.Empty:
                frame = b": keepalive\n\n"
            req.wfile.write(frame)
            req.wfile.flush()

    except (BrokenPipeError, ConnectionResetError, OSError):
        logger.info("Web app disconnected: %s", serial)

    finally:
        if conn in client_connections:
            client_connections.remove(conn)

def _send_quietly(write):
    # Run a client-socket write; swallow the error if the client already hung up.
    # A vanished browser shouldn't become a noisy traceback - and now that replies
    # are delivered from this handler thread, it can't affect anything else either.
    try:
        write()
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
        pass

def post_robot_command(req: RouterHandler, serial: str) -> None:
    """POST /robots/{serial}/command - send command to robot"""
    if not (data := req.read_json()): return

    if get_robot_by_serial(serial) is None:
        req.send_not_found("Robot not found")
        return

    if serial not in robot_connections:
        req.send_bad_request("Robot not connected")
        return

    conn = robot_connections[serial]
    slot = PendingRequest()
    if (conn.gen == Generation.GEN4):
        # gen4
        req_id, err = robot_send_request(conn, data, slot)
        if err:
            _send_quietly(lambda: req.send_error_response(502, "Failed to send command to robot"))
            return
    elif (conn.gen == Generation.GEN3) and isinstance(conn.conn, Gen2Gen3Conn):
        # gen3
        # any manual start/stop/dock takes over from a running zone queue
        if data.get("cmd") in zone_queue.CANCELLING_COMMANDS:
            zone_queue.cancel(serial, f"app sent {data.get('cmd')}")
        logger.debug("Sending command to robot %s: %s", serial, data)
        try:
            req_id = send_command(conn.conn.wfile, serial, data, slot)
        except Exception:
            _send_quietly(lambda: req.send_error_response(502, "Failed to send command to robot"))
            return
    else:
        req.send_bad_request("Unsupported robot generation")
        return

    key = str(req_id)
    slot.event.wait(COMMAND_TIMEOUT_S)
    pending_requests.pop(key, None)
    if slot.event.is_set():
        _send_quietly(lambda: req.send_response_data(slot.content, True, slot.status))
    else:
        _send_quietly(lambda: req.send_error_response(504, "Robot did not answer in time"))
    
    

def get_zone_queue(req: RouterHandler, serial: str) -> None:
    """GET /robot/<serial>/zone-queue - zones still queued for a gen3 robot (null when idle)"""
    req.send_ok({"queue": zone_queue.get_status(serial)})

def post_zone_queue(req: RouterHandler, serial: str) -> None:
    """POST /robot/<serial>/zone-queue - clean several gen3 zones one after another

    body: {"zones": [{"mapId", "boundaryId", "name"?}], "mode", "navigationMode"}
    """
    if not (data := req.read_json()): return

    if get_robot_by_serial(serial) is None:
        return req.send_not_found("Robot not found")
    conn = robot_connections.get(serial)
    if conn is None or conn.gen != Generation.GEN3:
        return req.send_bad_request("Robot not connected or not gen3")

    try:
        zones = [zone_queue.Zone(str(z["mapId"]), str(z["boundaryId"]), str(z.get("name") or "")) for z in data["zones"]]
        mode = int(data["mode"])
        navigation_mode = int(data["navigationMode"])
    except (KeyError, TypeError, ValueError):
        return req.send_bad_request("zones (mapId, boundaryId), mode and navigationMode are required")
    if not zones:
        return req.send_bad_request("zones must not be empty")

    ok, msg = zone_queue.start(serial, zones, mode, navigation_mode)
    if not ok:
        return _send_quietly(lambda: req.send_error_response(502, msg))
    _send_quietly(lambda: req.send_ok({"queue": zone_queue.get_status(serial)}))

def delete_zone_queue(req: RouterHandler, serial: str) -> None:
    """DELETE /robot/<serial>/zone-queue - drop the remaining zones (the current run continues)"""
    zone_queue.cancel(serial, "cancelled from the app")
    req.send_ok()
