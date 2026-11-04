"""Values of the gen3 (D7) protocol used by several modules, and the robot's time format."""
from __future__ import annotations
from datetime import datetime

# the robot's `state`
STATE_IDLE = 1
STATE_BUSY = 2
STATE_ERROR = 4
# `category` of a cleaning: map (with zones)
CATEGORY_MAP = 4
# `mode` and `navigationMode` of a cleaning
MODE_ECO = 1
NAV_DEEP = 3


def parse_time(value: str | None) -> datetime | None:
    """A robot timestamp ("2026-11-03T10:00:00Z"), None if missing or not one."""
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


def timestamp(value: str | None) -> float | None:
    """parse_time as epoch seconds."""
    return t.timestamp() if (t := parse_time(value)) else None
