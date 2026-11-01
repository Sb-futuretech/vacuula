"""[fork] telegram

Revision ID: e7b2c4d9f1a3
Revises: d2a6f3c8e915
Create Date: 2026-11-01 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e7b2c4d9f1a3'
down_revision: Union[str, Sequence[str], None] = 'd2a6f3c8e915'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'telegram_robot',
        sa.Column('robot', sa.String(), sa.ForeignKey('robot.serial', ondelete='CASCADE'), primary_key=True),
        sa.Column('bot_token', sa.String(), nullable=True),
        sa.Column('bot_name', sa.String(), nullable=True),
        sa.Column('chat_id', sa.String(), nullable=True),
        sa.Column('chat_name', sa.String(), nullable=True),
        sa.Column('kinds', sa.JSON(), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('telegram_robot')
