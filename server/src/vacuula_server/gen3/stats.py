"""Cleaning statistics of a gen3 robot, computed from its stored runs and notifications.

Only numbers leave here (no maps). Battery use is measured on runs without a recharge break,
over the time the robot was actually cleaning (not paused, in error or charging), and grouped by
the mode and navigation the robot reports for the run.
"""
from __future__ import annotations
from collections import Counter
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from vacuula_server.db import get_session
from vacuula_server.gen3.data import Gen3MapBoundaries
from vacuula_server.models.notification import Notification
from vacuula_server.models.run import Gen3__Run
from vacuula_server.server_tz import server_timezone

DAYS = 28  # length of the daily history
WEEKS = 26  # length of the weekly battery history


def _time(value: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


def _runs(serial: str) -> list[dict]:
    """The robot's finished runs, oldest first, with their duration worked out."""
    with get_session() as session:
        stored = session.execute(select(Gen3__Run.run).where(Gen3__Run.robot == serial)).scalars().all()
    runs = []
    for run in stored:
        start, end = _time(run.get("start_at")), _time(run.get("end_at"))
        if not start or not end or end < start:
            continue
        seconds = (end - start).total_seconds()
        idle = sum(run.get(k) or 0 for k in ("time_in_suspended_cleaning", "time_in_pause", "time_in_error"))
        runs.append({**run, "_start": start, "_seconds": seconds, "_active": max(seconds - idle, 0)})
    return sorted(runs, key=lambda r: r["_start"])


def _per_minute(area: float, seconds: float) -> float | None:
    return round(area / (seconds / 60), 2) if seconds > 0 else None


def _totals(runs: list[dict]) -> dict:
    area, seconds = sum(r.get("cleaned_area") or 0 for r in runs), sum(r["_active"] for r in runs)
    return {
        "runs": len(runs),
        "area": round(area, 1),
        "hours": round(seconds / 3600, 1),  # cleaning time, without breaks
        "areaPerMinute": _per_minute(area, seconds),
    }


def _used(run: dict) -> int | None:
    """Battery % a run used, None if that cannot be measured (recharged in between, no values)."""
    start, end = run.get("run_charge_at_start"), run.get("run_charge_at_end")
    if start is None or end is None or run.get("suspended_cleaning_charging_count") or end > start:
        return None
    return start - end


def _battery_point(run: dict) -> dict | None:
    used = _used(run)
    if used is None or run["_active"] <= 0:
        return None
    area = run.get("cleaned_area") or 0
    return {
        "startAt": run.get("start_at"),
        "mode": run.get("mode"),
        "navigationMode": run.get("navigation_mode"),
        "used": used,
        "area": round(area, 1),
        "perHour": round(used / (run["_active"] / 3600), 1),
        "chargeStart": run.get("run_charge_at_start"),
    }


def _battery_groups(runs: list[dict]) -> list[dict]:
    """Per mode + navigation the robot reported: every measurable run summed up, so each counts
    as much as it used (a short run barely moves the result, none is left out)."""
    groups: dict[tuple, dict] = {}
    for run in runs:
        if (used := _used(run)) is None:
            continue
        g = groups.setdefault((run.get("mode"), run.get("navigation_mode")), {"runs": 0, "used": 0, "seconds": 0.0, "area": 0.0})
        g["runs"] += 1
        g["used"] += used
        g["seconds"] += run["_active"]
        g["area"] += run.get("cleaned_area") or 0
    return [{
        "mode": mode,
        "navigationMode": nav,
        "runs": g["runs"],
        "used": g["used"],  # % in total: how much the numbers rest on
        "minutesPerCharge": round(g["seconds"] / 60 / g["used"] * 100) if g["used"] else None,
        "areaPerCharge": round(g["area"] / g["used"] * 100, 1) if g["used"] else None,
    } for (mode, nav), g in sorted(groups.items(), key=lambda kv: -kv[1]["used"])]


def _speed_groups(runs: list[dict]) -> list[dict]:
    """Area per minute of cleaning per mode + navigation, from every run with a cleaning time
    (a recharge break does not matter here, unlike for battery use)."""
    groups: dict[tuple, dict] = {}
    for run in runs:
        if run["_active"] <= 0:
            continue
        g = groups.setdefault((run.get("mode"), run.get("navigation_mode")), {"runs": 0, "seconds": 0.0, "area": 0.0})
        g["runs"] += 1
        g["seconds"] += run["_active"]
        g["area"] += run.get("cleaned_area") or 0
    return [{
        "mode": mode,
        "navigationMode": nav,
        "runs": g["runs"],
        "areaPerMinute": _per_minute(g["area"], g["seconds"]),
    } for (mode, nav), g in sorted(groups.items(), key=lambda kv: -kv[1]["seconds"])]


def _battery_weekly(runs: list[dict], tz: ZoneInfo, today) -> list[dict]:
    """Minutes per charge per week (starting Monday) and mode, from every measurable run: how the
    battery holds up over time. Mapping runs (no mode) are left out."""
    first = today - timedelta(days=today.weekday() + 7 * (WEEKS - 1))
    weeks: dict[tuple, dict] = {}
    for run in runs:
        if (used := _used(run)) is None or not used or run.get("mode") is None:
            continue
        day = run["_start"].astimezone(tz).date()
        if day < first:
            continue
        week = day - timedelta(days=day.weekday())
        w = weeks.setdefault((week, run["mode"]), {"runs": 0, "used": 0, "seconds": 0.0})
        w["runs"] += 1
        w["used"] += used
        w["seconds"] += run["_active"]
    return [{
        "week": week.isoformat(),
        "mode": mode,
        "runs": w["runs"],
        "used": w["used"],
        "minutesPerCharge": round(w["seconds"] / 60 / w["used"] * 100),
    } for (week, mode), w in sorted(weeks.items())]


def _zone_names(serial: str) -> dict[str, str]:
    """Zone id -> name, from the zones kept for the robot's maps."""
    with get_session() as session:
        rows = session.execute(select(Gen3MapBoundaries.boundaries).where(Gen3MapBoundaries.robot == serial)).scalars().all()
    return {b["id"]: b.get("name") or "" for boundaries in rows for b in boundaries or [] if isinstance(b, dict) and b.get("id")}


def _zones(serial: str, runs: list[dict]) -> list[dict]:
    """Per zone: how often and when it was last cleaned, how long it takes, how fast. Only runs
    whose zone was recorded (gen3/run_zone.py)."""
    zones: dict[str, dict] = {}
    for run in runs:
        if not (zone := run.get("zone")) or not zone.get("id"):
            continue
        z = zones.setdefault(zone["id"], {"name": "", "mapId": "", "runs": 0, "seconds": 0.0, "area": 0.0, "lastAt": None})
        z["runs"] += 1
        z["seconds"] += run["_active"]
        z["area"] += run.get("cleaned_area") or 0
        z["lastAt"] = run.get("start_at")  # runs are oldest first
        z["name"] = zone.get("name") or z["name"]
        z["mapId"] = zone.get("mapId") or z["mapId"]
    names = _zone_names(serial) if zones else {}
    return [{
        "id": zone_id,
        "name": names.get(zone_id) or z["name"],
        "mapId": z["mapId"],
        "runs": z["runs"],
        "lastAt": z["lastAt"],
        "minutes": round(z["seconds"] / 60 / z["runs"]),
        "area": round(z["area"] / z["runs"], 1),
        "areaPerMinute": _per_minute(z["area"], z["seconds"]),
    } for zone_id, z in sorted(zones.items(), key=lambda kv: kv[1]["lastAt"] or "", reverse=True)]


def _problems(serial: str) -> list[dict]:
    with get_session() as session:
        rows = session.execute(
            select(Notification.kind, Notification.code, func.count(), func.max(Notification.created_at))
            .where(Notification.robot == serial, Notification.kind.in_(("error", "alert")))
            .group_by(Notification.kind, Notification.code)
            .order_by(func.count().desc())
        ).all()
    return [{"kind": kind, "code": code, "count": count, "lastAt": last} for kind, code, count, last in rows]


def gen3_stats(serial: str) -> dict:
    runs = _runs(serial)
    now = datetime.now(timezone.utc)
    tz = ZoneInfo(server_timezone())

    today = now.astimezone(tz).date()
    days = {today - timedelta(days=i): {"area": 0.0, "runs": 0} for i in range(DAYS)}
    for run in runs:
        if (day := days.get(run["_start"].astimezone(tz).date())) is not None:
            day["area"] += run.get("cleaned_area") or 0
            day["runs"] += 1

    return {
        "totals": {
            "week": _totals([r for r in runs if r["_start"] >= now - timedelta(days=7)]),
            "month": _totals([r for r in runs if r["_start"] >= now - timedelta(days=30)]),
            "all": _totals(runs),
        },
        "daily": [{"date": d.isoformat(), "area": round(v["area"], 1), "runs": v["runs"]} for d, v in sorted(days.items())],
        "battery": [p for r in runs if (p := _battery_point(r))],
        "batteryGroups": _battery_groups(runs),
        "speedGroups": _speed_groups(runs),
        "batteryWeekly": _battery_weekly(runs, tz, today),
        "zones": _zones(serial, runs),
        "batteryNotMeasurable": sum(_used(r) is None for r in runs),
        "reliability": {
            "runs": len(runs),
            "complete": sum(r.get("status") == "complete" for r in runs),
            "canceled": sum(r.get("status") == "canceled" for r in runs),
            "withError": sum(bool(r.get("error")) for r in runs),
            "recharged": sum(bool(r.get("suspended_cleaning_charging_count")) for r in runs),
            "pickedUp": sum(r.get("picked_up_count") or 0 for r in runs),
            "localizationLost": sum(bool(r.get("localization_lost")) for r in runs),
        },
        "launchedFrom": dict(Counter(r.get("launched_from") or "unknown" for r in runs)),
        "problems": _problems(serial),
    }
