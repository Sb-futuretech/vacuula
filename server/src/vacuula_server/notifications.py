"""Notification centre: what happened with a robot, kept so the app can show it later.

Sources: a new robot error or alert (from every state the robot sends), a finished run (its map
upload), the robot being offline for a while and back, and the robot's own push_notifications
request. Each new notification is stored and pushed to connected apps as a `notification` event.
"""
from __future__ import annotations
import logging
import threading

from sqlalchemy import delete, select

from vacuula_server.db import get_session
from vacuula_server.models.notification import Notification
from vacuula_server.state import push_to_app, robot_connections

logger = logging.getLogger(__name__)

KEEP_PER_ROBOT = 300
# only report the robot as offline if it stays away this long (it reconnects now and then)
OFFLINE_AFTER_S = 5 * 60
# run statuses that mean the run is over (an upload can also arrive mid-run)
FINISHED_RUN_STATUSES = {"complete", "canceled"}


def _to_dict(n: Notification) -> dict:
    return {"id": n.id, "createdAt": n.created_at, "kind": n.kind, "code": n.code, "data": n.data}


def add(serial: str, kind: str, code: str | None = None, data: dict | None = None) -> None:
    try:
        with get_session() as session:
            n = Notification(robot=serial, kind=kind, code=code, data=data or {})
            session.add(n)
            session.flush()
            payload = _to_dict(n)
            # keep the newest KEEP_PER_ROBOT
            keep = select(Notification.id).where(Notification.robot == serial) \
                .order_by(Notification.id.desc()).limit(KEEP_PER_ROBOT)
            session.execute(delete(Notification).where(Notification.robot == serial, Notification.id.not_in(keep)))
            session.commit()
    except Exception:
        logger.exception("Failed to store %s notification for %s", kind, serial)
        return
    logger.info("Notification for %s: %s %s", serial, kind, code or "")
    push_to_app(serial, "notification", payload)


def recent(serial: str, limit: int = 100) -> list[dict]:
    with get_session() as session:
        rows = session.execute(
            select(Notification).where(Notification.robot == serial)
            .order_by(Notification.id.desc()).limit(limit)
        ).scalars().all()
        return [_to_dict(n) for n in rows]


def _latest_code(serial: str, kind: str) -> str | None:
    with get_session() as session:
        return session.execute(
            select(Notification.code).where(Notification.robot == serial, Notification.kind == kind)
            .order_by(Notification.id.desc()).limit(1)
        ).scalar_one_or_none()


# ---- robot errors and alerts ------------------------------------------------------------------
# serial -> {"error": code, "alert": code}, the last value the robot reported
_last_state: dict[str, dict[str, str | None]] = {}
_UNKNOWN = object()


def on_state(serial: str, data: dict) -> None:
    """Feed every robot state in here; a new error or alert code becomes a notification."""
    last = _last_state.setdefault(serial, {})
    for kind in ("error", "alert"):
        if kind not in data:
            continue
        code = data.get(kind)
        previous = last.get(kind, _UNKNOWN)
        last[kind] = code
        if not code or code == previous:
            continue
        # after a server restart a sticky alert is reported again: skip it if it was the last one
        if previous is _UNKNOWN and _latest_code(serial, kind) == code:
            continue
        add(serial, kind, code)


# ---- finished runs ------------------------------------------------------------------------------
def run_uploaded(serial: str, run: dict) -> None:
    """A run's map arrived; the first upload of a finished run becomes a notification."""
    run_id = run.get("id")
    if not run_id or run.get("status") not in FINISHED_RUN_STATUSES:
        return
    with get_session() as session:
        known = session.execute(
            select(Notification.id).where(Notification.robot == serial, Notification.kind == "run_done", Notification.code == run_id)
        ).first()
    if known:
        return
    add(serial, "run_done", run_id, {
        "status": run.get("status"),
        "category": run.get("category"),
        "startAt": run.get("start_at"),
        "endAt": run.get("end_at"),
        "cleanedArea": run.get("cleaned_area"),
        "chargeStart": run.get("run_charge_at_start"),
        "chargeEnd": run.get("run_charge_at_end"),
    })


# ---- offline / online ---------------------------------------------------------------------------
_offline_timers: dict[str, threading.Timer] = {}
_reported_offline: set[str] = set()


def robot_connected(serial: str) -> None:
    timer = _offline_timers.pop(serial, None)
    if timer:
        timer.cancel()
    if serial in _reported_offline:
        _reported_offline.discard(serial)
        add(serial, "online")


def robot_disconnected(serial: str) -> None:
    def still_gone() -> None:
        _offline_timers.pop(serial, None)
        if serial not in robot_connections:
            _reported_offline.add(serial)
            add(serial, "offline", data={"minutes": OFFLINE_AFTER_S // 60})

    timer = threading.Timer(OFFLINE_AFTER_S, still_gone)
    timer.daemon = True
    _offline_timers[serial] = timer
    timer.start()
