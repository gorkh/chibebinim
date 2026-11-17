from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    event,
    text,
)
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now() -> datetime:
    # SQLite stores naive datetimes; these values always represent UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def uid() -> str:
    return uuid4().hex


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    language_code: Mapped[str] = mapped_column(String(10), default="fa")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)
    last_active_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    onboarding_completed: Mapped[bool] = mapped_column(default=False)
    is_blocked: Mapped[bool] = mapped_column(default=False)


class CatalogEntry(Base):
    __tablename__ = "media"
    __table_args__ = (UniqueConstraint("source", "external_id", "media_type"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    source: Mapped[str] = mapped_column(String(20))
    external_id: Mapped[str] = mapped_column(String(100))
    media_type: Mapped[str] = mapped_column(String(5))
    metadata_json: Mapped[dict] = mapped_column(JSON)
    metadata_updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class CatalogQuery(Base):
    __tablename__ = "catalog_queries"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    media_ids: Mapped[list[str]] = mapped_column(JSON)
    fetched_at: Mapped[datetime] = mapped_column(DateTime)


class UserMedia(Base):
    __tablename__ = "user_media_interactions"
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    media_id: Mapped[str] = mapped_column(ForeignKey("media.id"), primary_key=True)
    preference: Mapped[str] = mapped_column(String(8), default="neutral")
    is_watched: Mapped[bool] = mapped_column(default=False)
    watched_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class WatchItem(Base):
    __tablename__ = "watchlist"
    __table_args__ = (Index("ix_watchlist_user_created", "user_id", "created_at"),)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    media_id: Mapped[str] = mapped_column(ForeignKey("media.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Preferences(Base):
    __tablename__ = "user_preferences"
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    genre_weights_json: Mapped[dict] = mapped_column(JSON, default=dict)
    preferred_media_types_json: Mapped[dict] = mapped_column(JSON, default=dict)
    preferred_languages_json: Mapped[dict] = mapped_column(JSON, default=dict)
    settings_json: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class RecSession(Base):
    __tablename__ = "recommendation_sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    request_json: Mapped[dict] = mapped_column(JSON)
    candidates: Mapped[list[dict]] = mapped_column(JSON)
    request_type: Mapped[str] = mapped_column(String(10))
    current_position: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class Recommendation(Base):
    __tablename__ = "recommendations"
    __table_args__ = (
        Index("ix_recommendations_user_date", "user_id", "recommended_at"),
        UniqueConstraint("session_id", "media_id"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    media_id: Mapped[str] = mapped_column(ForeignKey("media.id"))
    session_id: Mapped[str] = mapped_column(
        ForeignKey("recommendation_sessions.id", ondelete="CASCADE")
    )
    request_type: Mapped[str] = mapped_column(String(10))
    recommendation_score: Mapped[float] = mapped_column(Float)
    explanation: Mapped[str]
    recommended_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Event(Base):
    __tablename__ = "analytics_events"
    __table_args__ = (Index("ix_analytics_name_date", "event_name", "created_at"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    event_name: Mapped[str] = mapped_column(String(50))
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


def engine_for(url: str):
    parsed = make_url(url)
    if parsed.get_backend_name() != "sqlite":
        raise ValueError("This release supports SQLite only")
    if parsed.database and parsed.database != ":memory:":
        Path(parsed.database).parent.mkdir(parents=True, exist_ok=True)
    engine = create_async_engine(url, connect_args={"timeout": 10})

    @event.listens_for(engine.sync_engine, "connect")
    def configure_sqlite(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    return engine


def sessions_for(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


async def check_database(engine):
    async with engine.connect() as connection:
        await connection.execute(text("SELECT id FROM users LIMIT 1"))
