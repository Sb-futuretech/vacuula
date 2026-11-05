"""Telegram messages for the notification centre, one bot and chat per robot.

Every new notification (notifications.add) is offered here; if the robot has a bot, a chat and that
kind switched on, a short English text goes to the chat. Sending runs on one background thread, so a
slow or unreachable Telegram never holds up the robot's connection. Only text leaves the server, no
maps. The bot token stays on the server: the app only ever gets the bot's name.
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
import urllib.error
import urllib.request
from functools import cache

from vacuula_server.constants import BASE_DIR
from vacuula_server.db import get_session
from vacuula_server.gen3.protocol import parse_time as _time
from vacuula_server.generation import get_robot_by_serial
from vacuula_server.models.telegram import TelegramRobot

logger = logging.getLogger(__name__)

API = "https://api.telegram.org/bot{token}/{method}"
TIMEOUT_S = 15
RETRY_WAIT_S = (2, 10, 30)  # waits before the 2nd, 3rd and 4th try

# the groups the app offers, and which notification kinds belong to each
KINDS: dict[str, tuple[str, ...]] = {
    "error": ("error",),
    "alert": ("alert", "robot_push", "away_from_base"),
    "offline": ("offline",),
    "online": ("online",),
    "run_done": ("run_done",),
    "schedule": ("schedule_overlap", "schedule_skipped", "schedule_clock"),
}
DEFAULT_KINDS = ["error", "alert", "offline", "online"]
_GROUP_OF = {kind: group for group, kinds in KINDS.items() for kind in kinds}


class TelegramError(Exception):
    def __init__(self, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after


def _call(token: str, method: str, params: dict | None = None) -> dict | list:
    """One Bot API call; its `result`, or TelegramError with Telegram's own description."""
    request = urllib.request.Request(API.format(token=token, method=method), data=json.dumps(params or {}).encode(),
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
        except (ValueError, OSError):
            raise TelegramError(f"HTTP {e.code}") from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        # the URL holds the token: say only what went wrong
        reason = getattr(e, "reason", None) or type(e).__name__
        raise TelegramError(f"Telegram not reachable ({reason})") from None
    if not body.get("ok"):
        retry = (body.get("parameters") or {}).get("retry_after")
        raise TelegramError(body.get("description") or "Telegram refused the request", retry)
    return body.get("result")


# ---- settings -----------------------------------------------------------------------------------
def _row(session, serial: str) -> TelegramRobot:
    row = session.get(TelegramRobot, serial)
    if row is None:
        row = TelegramRobot(robot=serial, kinds=list(DEFAULT_KINDS), enabled=True)
        session.add(row)
    return row


def _to_dict(row: TelegramRobot | None) -> dict:
    return {
        "botName": row.bot_name if row else None,
        "tokenSet": bool(row and row.bot_token),
        "chatId": row.chat_id if row else None,
        "chatName": row.chat_name if row else None,
        "kinds": list(row.kinds) if row else list(DEFAULT_KINDS),
        "enabled": row.enabled if row else True,
        "groups": list(KINDS),
    }


def settings(serial: str) -> dict:
    with get_session() as session:
        return _to_dict(session.get(TelegramRobot, serial))


def update(serial: str, data: dict) -> tuple[dict | None, str]:
    """Change the robot's settings from an app request; the new settings, or None and why not.

    "token": checked with Telegram first (its bot name is kept); empty removes bot and chat.
    """
    bot_name = None
    token = data.get("token")
    if token:
        try:
            me = _call(str(token).strip(), "getMe")
        except TelegramError as e:
            return None, f"Token not accepted: {e}"
        bot_name = "@" + (me.get("username") or str(me.get("id")))
    kinds = data.get("kinds")
    if kinds is not None and (not isinstance(kinds, list) or any(k not in KINDS for k in kinds)):
        return None, f"kinds must be a list of {', '.join(KINDS)}"
    with get_session() as session:
        row = _row(session, serial)
        if token == "":
            row.bot_token = row.bot_name = row.chat_id = row.chat_name = None
        elif token:
            if row.bot_token != token.strip():
                row.chat_id = row.chat_name = None  # a chat belongs to its bot
            row.bot_token, row.bot_name = token.strip(), bot_name
        if "chatId" in data:
            row.chat_id = str(data["chatId"]) if data["chatId"] not in (None, "") else None
            row.chat_name = str(data.get("chatName") or "") or None
        if kinds is not None:
            row.kinds = kinds
        if "enabled" in data:
            row.enabled = bool(data["enabled"])
        session.commit()
        return _to_dict(row), ""


def _token(serial: str) -> str | None:
    with get_session() as session:
        row = session.get(TelegramRobot, serial)
        return row.bot_token if row else None


def find_chats(serial: str) -> tuple[list[dict] | None, str]:
    """Chats that wrote to the robot's bot lately (Telegram keeps them about a day)."""
    if not (token := _token(serial)):
        return None, "No bot token set"
    try:
        updates = _call(token, "getUpdates", {"limit": 100, "allowed_updates": ["message", "my_chat_member"]})
    except TelegramError as e:
        return None, str(e)
    chats: dict[str, dict] = {}
    for update in updates:
        chat = ((update.get("message") or update.get("my_chat_member") or {}).get("chat")) or {}
        if "id" not in chat:
            continue
        name = chat.get("title") or " ".join(p for p in (chat.get("first_name"), chat.get("last_name")) if p) \
            or chat.get("username") or str(chat["id"])
        chats[str(chat["id"])] = {"id": str(chat["id"]), "name": name, "type": chat.get("type")}
    return list(chats.values()), ""


def send_test(serial: str) -> tuple[bool, str]:
    with get_session() as session:
        row = session.get(TelegramRobot, serial)
        token, chat = (row.bot_token, row.chat_id) if row else (None, None)
    if not token or not chat:
        return False, "Set a bot token and pick a chat first"
    try:
        _call(token, "sendMessage", {"chat_id": chat, "text": f"👋 {_robot_name(serial)} will report here."})
    except TelegramError as e:
        return False, str(e)
    return True, ""


# ---- messages -----------------------------------------------------------------------------------
def _robot_name(serial: str) -> str:
    robot = get_robot_by_serial(serial)
    return robot.name if robot and robot.name else serial


@cache
def _code_texts() -> dict[str, str]:
    """The app's English texts for robot error and alert codes, if its locale file is at hand."""
    for path in (BASE_DIR / "locales" / "en.json", BASE_DIR.parent / "app" / "src" / "i18n" / "locales" / "en.json"):
        try:
            texts = json.loads(path.read_text(encoding="utf-8"))["robotErrorCode"]["neato"]
            return {**texts.get("gen4", {}), **texts.get("gen3", {})}
        except (OSError, ValueError, KeyError):
            continue
    return {}


def _code_text(code: str | None) -> str:
    if not code:
        return "unknown"
    return _code_texts().get(code) or code.replace("_", " ")


def _run_text(name: str, data: dict) -> str:
    done = data.get("status") == "complete"
    parts = []
    if (area := data.get("cleanedArea")) is not None:
        parts.append(f"{area:.0f} m²")
    start, end = _time(data.get("startAt")), _time(data.get("endAt"))
    if start and end and end > start:
        minutes = round((end - start).total_seconds() / 60)
        parts.append(f"{minutes // 60} h {minutes % 60:02d} min" if minutes >= 60 else f"{minutes} min")
    if data.get("chargeStart") is not None and data.get("chargeEnd") is not None:
        parts.append(f"battery {data['chargeStart']} → {data['chargeEnd']} %")
    head = f"✅ {name} finished cleaning" if done else f"⏹ {name} stopped cleaning"
    return head + (": " + ", ".join(parts) if parts else "")


SKIP_REASONS = {"robot_offline": "the robot was not connected", "robot_busy": "the robot was busy or not on its base",
                "refused": "the robot refused the start"}


def message(name: str, kind: str, code: str | None, data: dict) -> str | None:
    if kind == "error":
        return f"⚠️ {name}: {_code_text(code)}"
    if kind == "alert":
        return f"🔔 {name}: {_code_text(code)}"
    if kind == "robot_push":
        return f"💬 {name}: {_code_text(code) if code else data.get('body') or 'message from the robot'}"
    if kind == "away_from_base":
        return f"🏠 {name} stopped away from its base after cleaning (did it fail to dock?)"
    if kind == "offline":
        return f"📴 {name} has been offline for more than {data.get('minutes', 5)} min"
    if kind == "online":
        return f"📶 {name} is back online"
    if kind == "run_done":
        return _run_text(name, data)
    if kind == "schedule_skipped":
        return f"⏭ {name}: scheduled run {data.get('piTime', '')} did not start, {SKIP_REASONS.get(code or '', code or 'unknown reason')}"
    if kind == "schedule_overlap":
        times = ", ".join(data.get("robotTimes") or [])
        return f"🗓 {name}: Pi schedule {data.get('piTime', '')} ran; the robot's own entry {times} was skipped for it"
    if kind == "schedule_clock":
        return f"🕑 {name}: the robot's schedule clock was off, its entries were moved to keep their times"
    return None


# ---- sending ------------------------------------------------------------------------------------
_queue: queue.Queue[tuple[str, str, str]] = queue.Queue(maxsize=200)
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()


def _send_loop() -> None:
    while True:
        token, chat, text = _queue.get()
        for attempt in range(len(RETRY_WAIT_S) + 1):
            try:
                _call(token, "sendMessage", {"chat_id": chat, "text": text})
                break
            except TelegramError as e:
                if attempt == len(RETRY_WAIT_S):
                    logger.warning("Telegram message dropped after %d tries: %s", attempt + 1, e)
                    break
                time.sleep(e.retry_after or RETRY_WAIT_S[attempt])


def notify(serial: str, kind: str, code: str | None, data: dict) -> None:
    """Queue a notification for the robot's chat if it wants this kind; never raises."""
    global _worker
    try:
        group = _GROUP_OF.get(kind)
        with get_session() as session:
            row = session.get(TelegramRobot, serial)
            if not group or row is None or not row.enabled or not row.bot_token or not row.chat_id or group not in row.kinds:
                return
            token, chat = row.bot_token, row.chat_id
        if not (text := message(_robot_name(serial), kind, code, data)):
            return
        with _worker_lock:
            if _worker is None or not _worker.is_alive():
                _worker = threading.Thread(target=_send_loop, name="telegram", daemon=True)
                _worker.start()
        _queue.put_nowait((token, chat, text))
    except queue.Full:
        logger.warning("Telegram queue full, %s message for %s dropped", kind, serial)
    except Exception:
        logger.exception("Telegram message for %s not queued", serial)
