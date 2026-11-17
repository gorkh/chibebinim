import argparse
import asyncio
import json
import logging
import time
from datetime import timedelta
from urllib.request import getproxies, proxy_bypass

import httpx
from aiogram import Bot
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.types import BotCommand
from sqlalchemy import distinct, func, select

from app.bot import dispatcher
from app.catalog import CachedCatalog, FixtureProvider, TMDBProvider
from app.config import Settings
from app.db import Event, RecSession, User, check_database, engine_for, now, sessions_for
from app.domain import Request
from app.parser import OpenAIProvider
from app.service import Service
from app.watch import CCloudHomeProvider

log = logging.getLogger(__name__)
COMMANDS = {
    "start": "شروع",
    "menu": "منوی اصلی",
    "recommend": "پیشنهاد سریع",
    "watchlist": "فهرست تماشا",
    "profile": "سلیقهٔ من",
    "help": "راهنما",
    "privacy": "حریم خصوصی",
    "cancel": "لغو",
}


async def analytics(sessions):
    async with sessions() as db:
        events = dict(
            (
                await db.execute(select(Event.event_name, func.count()).group_by(Event.event_name))
            ).all()
        )
        ts = now()
        query = select(func.count(distinct(Event.user_id)))
        total_users = await db.scalar(select(func.count()).select_from(User))
        queues = await db.scalar(select(func.count()).select_from(RecSession))
        active_today = await db.scalar(
            query.where(Event.created_at >= ts.replace(hour=0, minute=0, second=0, microsecond=0))
        )
        active_week = await db.scalar(query.where(Event.created_at >= ts - timedelta(days=7)))
        # Use the most recent interaction time to include simple command/navigation users.
        active_today = max(
            active_today,
            await db.scalar(
                select(func.count())
                .select_from(User)
                .where(User.last_active_at >= ts.replace(hour=0, minute=0, second=0, microsecond=0))
            ),
        )
        active_week = max(
            active_week,
            await db.scalar(
                select(func.count())
                .select_from(User)
                .where(User.last_active_at >= ts - timedelta(days=7))
            ),
        )
        viewed = events.get("recommendation_viewed", 0)
        users_by_day = (
            await db.execute(
                select(User.id, User.created_at, User.last_active_at).where(
                    User.created_at <= ts - timedelta(days=7)
                )
            )
        ).all()
        # This is "returned at least seven days later", measured from latest activity.
        returned = sum(last >= created + timedelta(days=7) for _, created, last in users_by_day)
        token_data = await db.scalars(
            select(Event.metadata_json).where(Event.event_name == "ai_usage")
        )
        tokens = sum(d.get("tokens") or 0 for d in token_data)
        report = {
            "users": total_users,
            "active_today_utc": active_today,
            "active_last_7_days": active_week,
            "sessions": queues,
            "views_per_session": viewed / max(1, queues),
            "likes_per_view": events.get("movie_liked", 0) / max(1, viewed),
            "saves_per_view": events.get("watchlist_added", 0) / max(1, viewed),
            "ccloud_click_rate": None,  # Telegram URL buttons do not emit a callback.
            "returned_after_7_days": returned / len(users_by_day) if users_by_day else None,
            "ai_provider_calls": events.get("ai_request", 0)
            - sum(
                bool(d.get("cached"))
                for d in await db.scalars(
                    select(Event.metadata_json).where(Event.event_name == "ai_usage")
                )
            ),
            "ai_reported_tokens": tokens,
            "events": events,
        }
        print(json.dumps(report, indent=2))


async def run(mode: str):
    settings = Settings()
    logging.basicConfig(
        level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    logging.Formatter.converter = time.gmtime
    for library in ("httpx", "httpcore", "aiogram", "aiosqlite", "sqlalchemy", "urllib3"):
        logging.getLogger(library).setLevel(logging.CRITICAL)
    engine = engine_for(settings.database_url)
    try:
        await check_database(engine)
        sessions = sessions_for(engine)
        if mode == "analytics":
            await analytics(sessions)
            return
        async with httpx.AsyncClient(timeout=httpx.Timeout(5, connect=3)) as client:
            provider = (
                FixtureProvider()
                if settings.catalog_provider == "fixture"
                else TMDBProvider(
                    client,
                    str(settings.tmdb_api_base_url),
                    settings.tmdb_api_key.get_secret_value(),
                    settings.recommendation_candidate_limit,
                )
            )
            ai = (
                OpenAIProvider(
                    client,
                    str(settings.ai_base_url),
                    settings.ai_api_key.get_secret_value(),
                    settings.ai_model,
                    settings.ai_timeout,
                    settings.ai_max_output_tokens,
                )
                if settings.ai_enabled
                else None
            )
            service = Service(
                sessions,
                CachedCatalog(provider, settings.cache_ttl_hours, settings.catalog_provider),
                settings,
                ai,
            )
            dp = dispatcher(service, CCloudHomeProvider(str(settings.ccloud_base_url)))
            if mode == "check":
                if settings.catalog_provider == "fixture" and not await provider.discover(
                    Request()
                ):
                    raise RuntimeError("Offline catalog is empty")
                log.info("event=startup_check_ok catalog=%s", settings.catalog_provider)
                return
            if not settings.telegram_bot_token.get_secret_value():
                raise RuntimeError("TELEGRAM_BOT_TOKEN required")
            proxy = None if proxy_bypass("api.telegram.org") else getproxies().get("https")
            async with Bot(
                settings.telegram_bot_token.get_secret_value(), session=AiohttpSession(proxy=proxy)
            ) as bot:
                await bot.set_my_commands(
                    [BotCommand(command=cmd, description=label) for cmd, label in COMMANDS.items()]
                )
                log.info("event=startup catalog=%s", settings.catalog_provider)
                try:
                    # Telegram long polling supports only one worker per token.
                    await dp.start_polling(
                        bot, allowed_updates=dp.resolve_used_update_types(), close_bot_session=False
                    )
                finally:
                    log.info("event=shutdown")
    finally:
        await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description="چی ببینم؟")
    parser.add_argument("mode", nargs="?", default="poll", choices=["poll", "check", "analytics"])
    args = parser.parse_args()
    try:
        asyncio.run(run(args.mode))
    except KeyboardInterrupt:
        return
    except Exception as error:
        log.error(
            "event=startup_failed exception=%s; verify .env and run alembic upgrade head",
            type(error).__name__,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
