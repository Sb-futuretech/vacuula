"""The stretches a gen3 run cleaned between recharges, with the battery at both ends.

The robot's run upload only has the charge at the start and the end of the whole run, so a run that
recharged in between says nothing about battery use. Its state does: every message carries the
charge, and the action changes when it starts cleaning and when it drives back to the dock. Those
stretches are kept per robot and written into the run as `segments` on upload, for the battery
statistics. Runs from before this was recorded have none; a server restart during a run loses them
for that run.
"""
from __future__ import annotations
import time
from datetime import datetime, timezone

STATE_BUSY = 2
# house, spot, map (zone) cleaning, and a mapping run (it vacuums too)
CLEANING_ACTIONS = {1, 2, 11, 12}
# state times are the server's clock, run times the robot's: allow a little either way
SLACK_S = 120
KEEP_S = 2 * 24 * 3600

# serial -> the stretch being cleaned now: {"start", "charge_start"}
_open: dict[str, dict] = {}
# serial -> finished stretches: {"start", "end", "charge_start", "charge_end"} (epoch seconds)
_done: dict[str, list[dict]] = {}


def on_state(serial: str, data: dict) -> None:
    charge = (data.get("details") or {}).get("charge")
    if charge is None:
        return
    now = time.time()
    cleaning = data.get("state") == STATE_BUSY and data.get("action") in CLEANING_ACTIONS
    current = _open.get(serial)
    if cleaning and current is None:
        _open[serial] = {"start": now, "charge_start": charge}
    elif not cleaning and current is not None:
        del _open[serial]
        done = [s for s in _done.get(serial, []) if s["end"] > now - KEEP_S]
        done.append({**current, "end": now, "charge_end": charge})
        _done[serial] = done


def _ts(value: str | None) -> float | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else None
    except ValueError:
        return None


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def for_run(serial: str, run: dict) -> list[dict] | None:
    """The finished stretches inside `run`, None if there are none."""
    start, end = _ts(run.get("start_at")), _ts(run.get("end_at"))
    if start is None or end is None:
        return None
    segments = [{"start": _iso(s["start"]), "end": _iso(s["end"]), "seconds": round(s["end"] - s["start"]),
                 "charge_start": s["charge_start"], "charge_end": s["charge_end"]}
                for s in _done.get(serial, []) if s["start"] >= start - SLACK_S and s["end"] <= end + SLACK_S]
    return segments or None
