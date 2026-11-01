"""This fork's database versions, kept apart from upstream's.

Upstream records its schema version in `alembic_version` (migrations/). This fork's own tables and
columns are migrated by a second chain (migrations_fork/, `alembic -n fork`) recorded in
`alembic_version_fork`. An upstream server then still knows the version in `alembic_version` and
starts on the database; it ignores the fork's extra tables and its nullable extra columns.

Databases from before the split carry the fork's head in `alembic_version`. `split_versions()`
moves it to `alembic_version_fork` and puts back FORK_BASE, the upstream revision the fork chain was
built on. Run it before `alembic upgrade head` (the container does: `python -m
vacuula_server.fork_migrations`); it does nothing on a database that is already split or never ran
the fork.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic.config import Config
from alembic.script import ScriptDirectory

from vacuula_server.constants import ALEMBIC_INI

FORK_VERSION_TABLE = "alembic_version_fork"
# upstream 1.1.0-b1 ("keep track of installed with"): the fork's migrations started on top of it
FORK_BASE = "5fe01baecb7b"


def fork_script() -> ScriptDirectory:
    return ScriptDirectory.from_config(Config(str(ALEMBIC_INI), ini_section="fork"))


def split_versions(engine: sa.Engine) -> list[str]:
    """Move fork revisions out of `alembic_version` into the fork's own table. Returns those moved."""
    fork_revisions = {s.revision for s in fork_script().walk_revisions()}
    with engine.begin() as conn:
        if not sa.inspect(conn).has_table("alembic_version"):
            return []
        current = [row[0] for row in conn.execute(sa.text("SELECT version_num FROM alembic_version"))]
        moved = [rev for rev in current if rev in fork_revisions]
        if not moved:
            return []
        conn.execute(sa.text(
            f"CREATE TABLE IF NOT EXISTS {FORK_VERSION_TABLE} (version_num VARCHAR(32) NOT NULL, "
            f"CONSTRAINT {FORK_VERSION_TABLE}_pkc PRIMARY KEY (version_num))"))
        if conn.execute(sa.text(f"SELECT 1 FROM {FORK_VERSION_TABLE}")).first() is None:
            for rev in moved:
                conn.execute(sa.text(f"INSERT INTO {FORK_VERSION_TABLE} (version_num) VALUES (:v)"), {"v": rev})
        for rev in moved:
            conn.execute(sa.text("DELETE FROM alembic_version WHERE version_num = :v"), {"v": rev})
        if conn.execute(sa.text("SELECT 1 FROM alembic_version")).first() is None:
            conn.execute(sa.text("INSERT INTO alembic_version (version_num) VALUES (:v)"), {"v": FORK_BASE})
    return moved


def main() -> None:
    # imported here, not at the top: db imports this module
    from vacuula_server.db import DATABASE_URL

    moved = split_versions(sa.create_engine(DATABASE_URL))
    if moved:
        print(f"fork migrations: moved {', '.join(moved)} to {FORK_VERSION_TABLE}, "
              f"alembic_version back on upstream {FORK_BASE}")


if __name__ == "__main__":
    main()
