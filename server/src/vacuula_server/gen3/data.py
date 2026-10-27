from __future__ import annotations

from sqlalchemy import String, Integer, Boolean, Float, ForeignKey, JSON, true as sa_true
from sqlalchemy.orm import Mapped, mapped_column
from vacuula_server.db import Base

class Gen3Data(Base):
    __tablename__ = "gen3__data"

    robot: Mapped[str] = mapped_column(String, ForeignKey("robot.serial", ondelete='CASCADE'), primary_key=True)
    password: Mapped[str] = mapped_column(String, nullable=False)
    installed_with: Mapped[str] = mapped_column(String, nullable=False)
    # UTC offset (min) the robot's schedule was written with, to follow DST (gen3/schedule_tz.py)
    schedule_utc_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # the clock the robot runs its schedule on: "utc" (installed without a timezone; the default),
    # "local" (installed with one) or a fixed UTC offset in minutes such as "120";
    # learned from scheduled runs (gen3/schedule_tz.py)
    schedule_clock: Mapped[str | None] = mapped_column(String, nullable=True)
    # set while the server has switched the robot's own schedule off around one of its own runs
    # (gen3/pi_schedule.py): when to switch it on again, also after a server restart
    robot_schedule_paused_until: Mapped[int | None] = mapped_column(Integer, nullable=True)
    
    

# A stored map's zones and no-go lines, kept on the server so the app need not ask the robot each
# time (gen3/boundaries_cache.py). Only this server changes them, through setMapBoundaries.
class Gen3MapBoundaries(Base):
    __tablename__ = "gen3__map_boundaries"

    map_id: Mapped[str] = mapped_column(String, primary_key=True)
    robot: Mapped[str] = mapped_column(String, ForeignKey("robot.serial", ondelete='CASCADE'), nullable=False)
    boundaries: Mapped[list] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False)


# A schedule entry the server runs itself, for what the robot's own schedule cannot keep
# (navigation, several zones; gen3/pi_schedule.py). Times are the server's local time.
class Gen3PiSchedule(Base):
    __tablename__ = "gen3__pi_schedule"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    robot: Mapped[str] = mapped_column(String, ForeignKey("robot.serial", ondelete='CASCADE'), nullable=False, index=True)
    days: Mapped[list] = mapped_column(JSON, nullable=False)          # robot day numbers, 0 = Sunday
    start_time: Mapped[str] = mapped_column(String, nullable=False)   # HH:MM
    mode: Mapped[int] = mapped_column(Integer, nullable=False)
    navigation_mode: Mapped[int] = mapped_column(Integer, nullable=False)
    zones: Mapped[list] = mapped_column(JSON, nullable=False)         # [{mapId, boundaryId, name}], empty = whole map
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=sa_true())  # off: kept, not run
    last_run_at: Mapped[int | None] = mapped_column(Integer, nullable=True)  # start it was last run for
