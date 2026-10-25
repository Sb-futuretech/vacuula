"""Zones and no-go lines of gen3 stored maps, answered from the database.

The robot is only asked the first time (and its answer kept); a setMapBoundaries the robot accepts
replaces the kept copy. Saves a round trip per map on every page load, and the zones stay visible
while the robot is offline.
"""
from __future__ import annotations
import json
import time

from vacuula_server.db import get_session
from vacuula_server.gen3.data import Gen3MapBoundaries


def cached_reply(serial: str, cmd: dict) -> bytes | None:
    """The robot's reply to a getMapBoundaries, from the database; None if not kept yet."""
    if cmd.get("cmd") != "getMapBoundaries" or not (map_id := (cmd.get("params") or {}).get("mapId")):
        return None
    with get_session() as session:
        row = session.get(Gen3MapBoundaries, map_id)
        if row is None or row.robot != serial:
            return None
        return json.dumps({"version": 1, "result": "ok", "data": {"boundaries": row.boundaries}}).encode()


def remember(serial: str, cmd: dict, content, status: int | None) -> None:
    """Keep the boundaries from the robot's answer to getMapBoundaries / setMapBoundaries."""
    if status != 200 or cmd.get("cmd") not in ("getMapBoundaries", "setMapBoundaries"):
        return
    if not (map_id := (cmd.get("params") or {}).get("mapId")):
        return
    try:
        boundaries = json.loads(content)["data"]["boundaries"]
    except (ValueError, KeyError, TypeError):
        return
    with get_session() as session:
        row = session.get(Gen3MapBoundaries, map_id)
        if row is None:
            session.add(Gen3MapBoundaries(map_id=map_id, robot=serial, boundaries=boundaries, updated_at=int(time.time())))
        else:
            row.boundaries, row.updated_at = boundaries, int(time.time())
        session.commit()
