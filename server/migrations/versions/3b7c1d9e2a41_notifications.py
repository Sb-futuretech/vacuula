"""[fork] notifications

Revision ID: 3b7c1d9e2a41
Revises: 5fe01baecb7b
Create Date: 2026-10-25 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3b7c1d9e2a41'
down_revision: Union[str, Sequence[str], None] = '5fe01baecb7b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'notification',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('robot', sa.String(), sa.ForeignKey('robot.serial', ondelete='CASCADE'), nullable=False),
        sa.Column('created_at', sa.Integer(), nullable=False),
        sa.Column('kind', sa.String(), nullable=False),
        sa.Column('code', sa.String(), nullable=True),
        sa.Column('data', sa.JSON(), nullable=False),
    )
    op.create_index('ix_notification_robot', 'notification', ['robot'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_notification_robot', table_name='notification')
    op.drop_table('notification')
