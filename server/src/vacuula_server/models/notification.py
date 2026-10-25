from __future__ import annotations

import time
from typing import Any

from sqlalchemy import String, Integer, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column

from vacuula_server.db import Base


# Messages for the app's notification centre, kept on the server so nothing is missed while the
# app is closed (see vacuula_server/notifications.py)
class Notification(Base):
    __tablename__ = "notification"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    robot: Mapped[str] = mapped_column(String, ForeignKey("robot.serial", ondelete='CASCADE'), nullable=False, index=True)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False, default=lambda: int(time.time()))

    # run_done | error | alert | offline | online | robot_push
    kind: Mapped[str] = mapped_column(String, nullable=False)
    # what it is about: the robot's error / alert / push message code, or the run id for run_done
    code: Mapped[str | None] = mapped_column(String, nullable=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
