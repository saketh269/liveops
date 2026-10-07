"""initial portal schema: sources, sites, mappings

Revision ID: 0001
Revises:
Create Date: 2026-10-06
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sources",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("type", sa.String(50), nullable=False),
        sa.Column("settings", sa.JSON(), nullable=False),
        sa.Column("secrets_enc", sa.Text(), nullable=True),
        sa.Column("created_ts", sa.Float(), nullable=False),
        sa.Column("updated_ts", sa.Float(), nullable=False),
    )
    op.create_table(
        "sites",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("template", sa.String(50), nullable=False),
        sa.Column("layout", sa.JSON(), nullable=False),
        sa.Column("created_ts", sa.Float(), nullable=False),
        sa.Column("updated_ts", sa.Float(), nullable=False),
    )
    op.create_table(
        "mappings",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_id", sa.String(32), sa.ForeignKey("sources.id", ondelete="CASCADE"), nullable=False),
        sa.Column("dataset", sa.String(300), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("options", sa.JSON(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_ts", sa.Float(), nullable=False),
        sa.Column("updated_ts", sa.Float(), nullable=False),
    )
    op.create_index("ix_mappings_site_id", "mappings", ["site_id"])
    op.create_index("ix_mappings_source_id", "mappings", ["source_id"])


def downgrade() -> None:
    op.drop_table("mappings")
    op.drop_table("sites")
    op.drop_table("sources")
