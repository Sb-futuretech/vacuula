"""[fork] gen3 schedule utc offset

Revision ID: 7c2e4a9d1b53
Revises: 3b7c1d9e2a41
Create Date: 2026-10-25 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7c2e4a9d1b53'
down_revision: Union[str, Sequence[str], None] = '3b7c1d9e2a41'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('gen3__data', sa.Column('schedule_utc_offset', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('gen3__data') as batch_op:
        batch_op.drop_column('schedule_utc_offset')
