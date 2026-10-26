"""[fork] gen3 pi schedule: entries can be switched off

Revision ID: d2a6f3c8e915
Revises: c5e8a1d4f7b2
Create Date: 2026-10-26 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd2a6f3c8e915'
down_revision: Union[str, Sequence[str], None] = 'c5e8a1d4f7b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('gen3__pi_schedule', sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('gen3__pi_schedule') as batch_op:
        batch_op.drop_column('enabled')
