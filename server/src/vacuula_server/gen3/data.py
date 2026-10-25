from __future__ import annotations

from sqlalchemy import String, Integer, Boolean, Float, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column
from vacuula_server.db import Base

class Gen3Data(Base):
    __tablename__ = "gen3__data"

    robot: Mapped[str] = mapped_column(String, ForeignKey("robot.serial", ondelete='CASCADE'), primary_key=True)
    password: Mapped[str] = mapped_column(String, nullable=False)
    installed_with: Mapped[str] = mapped_column(String, nullable=False)
    # UTC offset (min) the robot's schedule was written with, to follow DST (gen3/schedule_tz.py)
    schedule_utc_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    
    