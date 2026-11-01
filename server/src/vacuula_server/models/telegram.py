from __future__ import annotations

from sqlalchemy import JSON, Boolean, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from vacuula_server.db import Base


# Telegram messages of one robot (see vacuula_server/telegram.py): each robot has its own bot and
# chat, so two households on one server never see each other's messages.
class TelegramRobot(Base):
    __tablename__ = "telegram_robot"

    robot: Mapped[str] = mapped_column(String, ForeignKey("robot.serial", ondelete='CASCADE'), primary_key=True)
    # never sent to the app; bot_name is what it shows instead
    bot_token: Mapped[str | None] = mapped_column(String, nullable=True)
    bot_name: Mapped[str | None] = mapped_column(String, nullable=True)
    chat_id: Mapped[str | None] = mapped_column(String, nullable=True)
    chat_name: Mapped[str | None] = mapped_column(String, nullable=True)
    # notification groups to send: error, alert, offline, online, run_done, schedule
    kinds: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
