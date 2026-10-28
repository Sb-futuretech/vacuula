"""What the robot says about its battery, read once per run on upload.

getGeneralInfo has the battery's charge cycles and the robot's estimate of the time left;
getRobotInfo (debug info) has the battery's serial number and design capacity and the machine's
total running time. Kept in the run as `battery_info`, for the statistics: the newest reading is
shown, and a change of the battery serial marks a new battery.
"""
from __future__ import annotations

from vacuula_server.gen3.commands import ask


def read(serial: str) -> dict | None:
    """The robot's battery and running-time figures now, None if it does not answer."""
    general = ((ask(serial, {"cmd": "getGeneralInfo"}) or {}).get("data") or {}).get("battery") or {}
    debug = (ask(serial, {"cmd": "getRobotInfo"}) or {}).get("data") or {}
    info = {
        "serial": debug.get("serial_number"),
        "vendor": general.get("vendor") or debug.get("mfg_name"),
        "designCapacity": debug.get("design_capacity"),
        "totalCharges": general.get("totalCharges"),
        "timeToEmpty": general.get("timeToEmpty"),  # seconds, the robot's estimate at the time
        "level": general.get("level"),
        "runSeconds": debug.get("CumulativeCartridgeTimeInSecs"),
    }
    return info if any(v is not None for v in info.values()) else None
