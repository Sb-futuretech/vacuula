"""Alembic environment for this fork's own migrations (`alembic -n fork ...`).

They run after upstream's chain (migrations/) and are recorded in their own version table, so
`alembic_version` only ever holds upstream revisions and an upstream server still starts on the
database: it ignores the fork's extra tables and its nullable extra columns.
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from vacuula_server.db import DATABASE_URL, Base
from vacuula_server.fork_migrations import FORK_VERSION_TABLE
from vacuula_server.gen3 import data as gen3_data  # noqa: F401  (registers the tables on Base.metadata)
from vacuula_server.gen4 import data as gen4_data  # noqa: F401  (registers the tables on Base.metadata)
from vacuula_server.models import notification, persistent_map, robot, run  # noqa: F401  (registers the tables on Base.metadata)

config = context.config
config.set_main_option("sqlalchemy.url", DATABASE_URL)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        version_table=FORK_VERSION_TABLE,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection, target_metadata=target_metadata, version_table=FORK_VERSION_TABLE
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
