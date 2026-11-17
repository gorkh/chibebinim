"""Create the initial schema."""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def required(name, kind):
    return sa.Column(name, kind, nullable=False)


def fk(name, target, kind, *, key=False, cascade=False, nullable=False):
    return sa.Column(
        name,
        kind,
        sa.ForeignKey(target, ondelete="CASCADE" if cascade else None),
        primary_key=key,
        nullable=nullable,
    )


def upgrade():
    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        required("telegram_id", sa.BigInteger),
        required("language_code", sa.String(10)),
        required("created_at", sa.DateTime),
        required("updated_at", sa.DateTime),
        required("last_active_at", sa.DateTime),
        required("onboarding_completed", sa.Boolean),
        required("is_blocked", sa.Boolean),
    )
    op.create_index("ix_users_telegram_id", "users", ["telegram_id"], unique=True)
    op.create_table(
        "media",
        sa.Column("id", sa.String(32), primary_key=True),
        required("source", sa.String(20)),
        required("external_id", sa.String(100)),
        required("media_type", sa.String(5)),
        required("metadata_json", sa.JSON),
        required("metadata_updated_at", sa.DateTime),
        required("created_at", sa.DateTime),
        sa.UniqueConstraint("source", "external_id", "media_type"),
    )
    op.create_table(
        "catalog_queries",
        sa.Column("key", sa.String(64), primary_key=True),
        required("media_ids", sa.JSON),
        required("fetched_at", sa.DateTime),
    )
    op.create_table(
        "user_media_interactions",
        fk("user_id", "users.id", sa.Integer, key=True, cascade=True),
        fk("media_id", "media.id", sa.String(32), key=True),
        required("preference", sa.String(8)),
        required("is_watched", sa.Boolean),
        sa.Column("watched_at", sa.DateTime),
        required("created_at", sa.DateTime),
        required("updated_at", sa.DateTime),
    )
    op.create_table(
        "watchlist",
        fk("user_id", "users.id", sa.Integer, key=True, cascade=True),
        fk("media_id", "media.id", sa.String(32), key=True),
        required("created_at", sa.DateTime),
    )
    op.create_index("ix_watchlist_user_created", "watchlist", ["user_id", "created_at"])
    op.create_table(
        "user_preferences",
        fk("user_id", "users.id", sa.Integer, key=True, cascade=True),
        required("genre_weights_json", sa.JSON),
        required("preferred_media_types_json", sa.JSON),
        required("preferred_languages_json", sa.JSON),
        required("settings_json", sa.JSON),
        required("updated_at", sa.DateTime),
    )
    op.create_table(
        "recommendation_sessions",
        sa.Column("id", sa.String(32), primary_key=True),
        fk("user_id", "users.id", sa.Integer, cascade=True),
        required("request_json", sa.JSON),
        required("candidates", sa.JSON),
        required("request_type", sa.String(10)),
        required("current_position", sa.Integer),
        required("created_at", sa.DateTime),
        required("expires_at", sa.DateTime),
    )
    op.create_index("ix_recommendation_sessions_user_id", "recommendation_sessions", ["user_id"])
    op.create_table(
        "recommendations",
        sa.Column("id", sa.String(32), primary_key=True),
        fk("user_id", "users.id", sa.Integer, cascade=True),
        fk("media_id", "media.id", sa.String(32)),
        fk("session_id", "recommendation_sessions.id", sa.String(32), cascade=True),
        required("request_type", sa.String(10)),
        required("recommendation_score", sa.Float),
        required("explanation", sa.String),
        required("recommended_at", sa.DateTime),
        sa.UniqueConstraint("session_id", "media_id"),
    )
    op.create_index(
        "ix_recommendations_user_date", "recommendations", ["user_id", "recommended_at"]
    )
    op.create_table(
        "analytics_events",
        sa.Column("id", sa.Integer, primary_key=True),
        fk("user_id", "users.id", sa.Integer, cascade=True, nullable=True),
        required("event_name", sa.String(50)),
        required("metadata_json", sa.JSON),
        required("created_at", sa.DateTime),
    )
    op.create_index("ix_analytics_name_date", "analytics_events", ["event_name", "created_at"])
    op.create_index("ix_analytics_events_user_id", "analytics_events", ["user_id"])
    op.create_index("ix_analytics_events_created_at", "analytics_events", ["created_at"])


def downgrade():
    for table in (
        "analytics_events",
        "recommendations",
        "recommendation_sessions",
        "user_preferences",
        "watchlist",
        "user_media_interactions",
        "catalog_queries",
        "media",
        "users",
    ):
        op.drop_table(table)
