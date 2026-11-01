"""[fork] gen3 schedule clock (utc / local)

Revision ID: c5e8a1d4f7b2
Revises: b3d7e5f9a214
Create Date: 2026-10-25 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c5e8a1d4f7b2'
down_revision: Union[str, Sequence[str], None] = 'b3d7e5f9a214'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('gen3__data', sa.Column('schedule_clock', sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('gen3__data') as batch_op:
        batch_op.drop_column('schedule_clock')
