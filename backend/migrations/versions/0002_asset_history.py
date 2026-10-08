"""asset history: every recorded change of an asset, for the History panel and journeys

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-07
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "asset_history",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), primary_key=True, autoincrement=True),
        sa.Column("site_id", sa.String(32), nullable=False),
        sa.Column("asset_id", sa.String(300), nullable=False),
        sa.Column("ts", sa.Float(), nullable=False),
        sa.Column("op", sa.String(10), nullable=False),
        sa.Column("removed", sa.Boolean(), nullable=False),
        sa.Column("source_id", sa.String(32), nullable=False),
        sa.Column("mapping_id", sa.String(32), nullable=False),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("ctx", sa.JSON(), nullable=True),
    )
    op.create_index("ix_asset_history_site_asset_ts", "asset_history", ["site_id", "asset_id", "ts"])
    op.create_index("ix_asset_history_site_ts", "asset_history", ["site_id", "ts"])
    op.create_index("ix_asset_history_ts", "asset_history", ["ts"])


def downgrade() -> None:
    op.drop_table("asset_history")
