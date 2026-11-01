"""[fork] gen3 schedule run by the server

Revision ID: b3d7e5f9a214
Revises: 9e4f1a2b6c87
Create Date: 2026-10-25 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3d7e5f9a214'
down_revision: Union[str, Sequence[str], None] = '9e4f1a2b6c87'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'gen3__pi_schedule',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('robot', sa.String(), sa.ForeignKey('robot.serial', ondelete='CASCADE'), nullable=False),
        sa.Column('days', sa.JSON(), nullable=False),
        sa.Column('start_time', sa.String(), nullable=False),
        sa.Column('mode', sa.Integer(), nullable=False),
        sa.Column('navigation_mode', sa.Integer(), nullable=False),
        sa.Column('zones', sa.JSON(), nullable=False),
        sa.Column('last_run_at', sa.Integer(), nullable=True),
    )
    op.create_index('ix_gen3__pi_schedule_robot', 'gen3__pi_schedule', ['robot'])
    op.add_column('gen3__data', sa.Column('robot_schedule_paused_until', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('gen3__data') as batch_op:
        batch_op.drop_column('robot_schedule_paused_until')
    op.drop_index('ix_gen3__pi_schedule_robot', table_name='gen3__pi_schedule')
    op.drop_table('gen3__pi_schedule')
