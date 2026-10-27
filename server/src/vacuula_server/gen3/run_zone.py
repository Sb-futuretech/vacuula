"""Which zone a gen3 run cleaned.

The robot's run upload does not say; its state does while it cleans (`cleaning.boundary` with
category map). The last zone seen is kept per robot and written into the run when it is uploaded,
for the per-zone statistics. Runs from before this was recorded have no zone.
"""
from __future__ import annotations
import time
from datetime import datetime

STATE_BUSY = 2
CATEGORY_MAP = 4
# state times are the server's clock, run times the robot's: allow a little either way
SLACK_S = 120

# serial -> {"id", "name", "mapId", "at"}; "id" None while cleaning without a zone
_seen: dict[str, dict] = {}


def on_state(serial: str, data: dict) -> None:
    if data.get("state") != STATE_BUSY:
        return
    cleaning = data.get("cleaning") or {}
    boundary = cleaning.get("boundary") or {}
    if cleaning.get("category") == CATEGORY_MAP and boundary.get("id"):
        _seen[serial] = {"id": boundary["id"], "name": boundary.get("name") or "", "mapId": cleaning.get("mapId") or "",
                         "at": time.time()}
    else:
        _seen[serial] = {"id": None, "at": time.time()}


def _ts(value: str | None) -> float | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else None
    except ValueError:
        return None


def for_run(serial: str, run: dict) -> dict | None:
    """The zone the robot was seen cleaning during `run`, None for a whole map or when unknown."""
    seen, start, end = _seen.get(serial), _ts(run.get("start_at")), _ts(run.get("end_at"))
    if not seen or not seen["id"] or start is None or seen["at"] < start - SLACK_S:
        return None
    if end is not None and seen["at"] > end + SLACK_S:
        return None
    return {"id": seen["id"], "name": seen["name"], "mapId": seen["mapId"] or run.get("persistent_map_id") or ""}
