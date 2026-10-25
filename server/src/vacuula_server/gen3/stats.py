"""Cleaning statistics of a gen3 robot, computed from its stored runs and notifications.

Only numbers leave here (no maps). Battery use is measured on runs without a recharge break,
over the time the robot was actually cleaning (not paused, in error or charging).
"""
from __future__ import annotations
from collections import Counter
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from vacuula_server.db import get_session
from vacuula_server.models.notification import Notification
from vacuula_server.models.run import Gen3__Run
from vacuula_server.server_tz import server_timezone

DAYS = 28  # length of the daily history
# runs shorter or smaller than this say little about the battery (undocking dominates)
BATTERY_MIN_ACTIVE_S = 5 * 60
BATTERY_MIN_AREA_M2 = 2


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


def _totals(runs: list[dict]) -> dict:
    return {
        "runs": len(runs),
        "area": round(sum(r.get("cleaned_area") or 0 for r in runs), 1),
        "hours": round(sum(r["_active"] for r in runs) / 3600, 1),  # cleaning time, without breaks
    }


def _battery_point(run: dict) -> dict | None:
    start, end = run.get("run_charge_at_start"), run.get("run_charge_at_end")
    area = run.get("cleaned_area") or 0
    if start is None or end is None or start <= end or run.get("suspended_cleaning_charging_count"):
        return None
    if run["_active"] < BATTERY_MIN_ACTIVE_S or area < BATTERY_MIN_AREA_M2:
        return None
    used = start - end
    return {
        "startAt": run.get("start_at"),
        "mode": run.get("mode"),
        "used": used,
        "area": round(area, 1),
        "perHour": round(used / (run["_active"] / 3600), 1),
        "perM2": round(used / area, 2),
        "chargeStart": start,
    }


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
