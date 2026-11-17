"""Measure fresh and cached TMDB runs without touching the live SQLite database."""

import argparse
import asyncio
import json

import httpx
from sqlalchemy import event

from app.catalog import CachedCatalog, TMDBProvider
from app.config import Settings
from app.db import Base, engine_for, sessions_for
from app.service import Card, Service


async def measure(message: str) -> None:
    settings = Settings()
    key = settings.tmdb_api_key.get_secret_value()
    if not key:
        raise RuntimeError("TMDB_API_KEY is required")
    engine = engine_for("sqlite+aiosqlite:///:memory:")
    counters = {"tmdb_calls": 0, "sqlite_rows_written": 0}

    @event.listens_for(engine.sync_engine, "after_cursor_execute")
    def count_writes(connection, cursor, statement, parameters, context, executemany):
        verb = statement.lstrip().split(maxsplit=1)[0].upper()
        if verb in {"INSERT", "UPDATE", "DELETE"}:
            counters["sqlite_rows_written"] += max(cursor.rowcount, 0)

    async def count_call(request):
        counters["tmdb_calls"] += 1

    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with httpx.AsyncClient(timeout=5, event_hooks={"request": [count_call]}) as client:
            provider = TMDBProvider(
                client,
                str(settings.tmdb_api_base_url),
                key,
                settings.recommendation_candidate_limit,
            )
            service = Service(sessions_for(engine), CachedCatalog(provider, 168, "tmdb"), settings)

            async def step(name, telegram_id, operation):
                before = counters.copy()
                user = await service.user(telegram_id)
                result = await operation(user)
                if isinstance(result, Card) and name != "save":
                    await service.event(user, "recommendation_viewed")
                consumed = {k: counters[k] - before[k] for k in counters}
                print(
                    json.dumps(
                        {
                            "step": name,
                            **consumed,
                            "title": getattr(getattr(result, "media", None), "title", None),
                        }
                    ),
                    flush=True,
                )
                return result

            async def smart(user):
                request = await service.interpret(user, message)
                result = await service.start(user, request, "smart")
                if not isinstance(result, Card):
                    raise RuntimeError("Smart test did not return a card")
                return result

            await step(
                "smart_menu", 100, lambda user: service.event(user, "smart_recommendation_started")
            )
            first = await step("first_cold", 100, smart)
            second = await step(
                "next", 100, lambda user: service.next(user, first.recommendation_id)
            )
            if not isinstance(second, Card):
                raise RuntimeError("No second recommendation")
            await step(
                "save", 100, lambda user: service.feedback(user, second.recommendation_id, "save")
            )
            await step("first_warm", 101, smart)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("message", nargs="?", default="یه انیمه شبیه Scavengers Reign")
    try:
        asyncio.run(measure(parser.parse_args().message))
    except Exception as error:
        raise SystemExit(f"Measurement failed: {type(error).__name__}") from None
