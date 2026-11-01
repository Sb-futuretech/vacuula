"""[fork] gen3 map boundaries cache

Revision ID: 9e4f1a2b6c87
Revises: 7c2e4a9d1b53
Create Date: 2026-10-25 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9e4f1a2b6c87'
down_revision: Union[str, Sequence[str], None] = '7c2e4a9d1b53'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'gen3__map_boundaries',
        sa.Column('map_id', sa.String(), primary_key=True),
        sa.Column('robot', sa.String(), sa.ForeignKey('robot.serial', ondelete='CASCADE'), nullable=False),
        sa.Column('boundaries', sa.JSON(), nullable=False),
        sa.Column('updated_at', sa.Integer(), nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('gen3__map_boundaries')
