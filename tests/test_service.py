import json
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import func, select, update

from app.catalog import CachedCatalog, CatalogUnavailable, FixtureProvider
from app.config import Settings
from app.db import (
    CatalogQuery,
    Event,
    Preferences,
    Recommendation,
    RecSession,
    User,
    UserMedia,
    WatchItem,
    engine_for,
    now,
    sessions_for,
)
from app.domain import Request
from app.parser import OpenAIProvider
from app.service import ChooseReference, ReferenceMissing, Service, StaleCard


async def test_preferences_sessions_privacy_and_restart(service, database_url):
    u = await service.user(1001, started=True)
    other = await service.user(1002)
    assert u == await service.user(1001, started=True)
    request = Request(media_type="movie", genres=["comedy"])
    first = await service.start(u, request, "quick")
    assert first.media.media_type == "movie" and "comedy" in first.media.genres
    with pytest.raises(StaleCard):
        await service.feedback(other, first.recommendation_id, "liked")
    with pytest.raises(StaleCard):
        await service.next(other, first.recommendation_id)
    await service.feedback(u, first.recommendation_id, "liked")
    await service.feedback(u, first.recommendation_id, "liked")
    await service.feedback(u, first.recommendation_id, "watched")
    await service.feedback(u, first.recommendation_id, "save")
    await service.feedback(u, first.recommendation_id, "save")
    genres, _, likes, watched, saved = await service.profile(u)
    assert (genres["comedy"], likes, watched, saved) == (1, 1, 1, 1)
    second = await service.next(u, first.recommendation_id)
    assert second.media.id != first.media.id
    with pytest.raises(StaleCard):
        await service.next(u, first.recommendation_id)
    await service.feedback(u, second.recommendation_id, "disliked")
    await service.remove_watch(other, first.media.id)
    async with service.sessions() as db:
        assert (
            await db.scalar(
                select(func.count()).select_from(Event).where(Event.event_name == "movie_liked")
            )
            == 1
        )
        assert await db.scalar(select(func.count()).select_from(WatchItem)) == 1

    engine = engine_for(database_url)
    fresh = Service(sessions_for(engine), service.catalog, service.settings)
    try:
        assert await fresh.user(1001) == u
        assert (await fresh.watchlist(u, 0))[0][0].id == first.media.id
        latest = await fresh.start(u, request, "quick")
        assert latest.media.id not in {first.media.id, second.media.id}
        await fresh.remove_watch(u, first.media.id)
        assert (await fresh.profile(u))[-3:] == (1, 1, 0)
        await fresh.reset_taste(u)
        assert (await fresh.profile(u))[-3:] == (0, 1, 0)
        await fresh.delete_user(u)
        async with fresh.sessions() as db:
            for model in (UserMedia, WatchItem, Recommendation, RecSession, Preferences, Event):
                assert (
                    await db.scalar(
                        select(func.count()).select_from(model).where(model.user_id == u)
                    )
                    == 0
                )
            assert await db.get(User, other)
            assert not await db.get(User, u)
    finally:
        await engine.dispose()


async def test_catalog_errors_use_only_an_existing_matching_cache(service):
    class BrokenFixture(FixtureProvider):
        fail = False

        async def discover(self, request):
            if self.fail:
                raise CatalogUnavailable
            return await super().discover(request)

    provider = BrokenFixture()
    service.catalog = CachedCatalog(provider, 1, "fixture")
    user = await service.user(101)
    request = Request(media_type="movie", max_runtime_minutes=119)
    card = await service.start(user, request, "smart")
    assert card.media.runtime_minutes <= 119
    async with service.sessions.begin() as db:
        await db.execute(update(CatalogQuery).values(fetched_at=now() - timedelta(hours=3)))
    provider.fail = True
    cached = await service.start(user, request, "smart")
    assert cached.media.runtime_minutes <= 119
    with pytest.raises(CatalogUnavailable):
        await service.start(user, Request(media_type="tv"), "quick")


async def test_ai_invalid_output_uses_fallback(service):
    async def invalid(request):
        return httpx.Response(200, json={"choices": [{"message": {"content": "{bad json"}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(invalid)) as client:
        service.ai = OpenAIProvider(
            client, "https://example.invalid/v1", "placeholder", "mock", 1, 200
        )
        user = await service.user(110)
        request = await service.interpret(user, "فیلم معمایی زیر یک ساعت")
        assert request.max_runtime_minutes == 59
        # No fixture mystery is short enough; the app never broadens the request.
        assert await service.start(user, request, "smart") is None
        async with service.sessions() as db:
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(Event)
                    .where(Event.event_name == "ai_request_failed")
                )
                == 1
            )


async def test_similar_reference_is_excluded_and_ambiguity_requires_confirmation(service):
    user = await service.user(703)
    card = await service.start(user, Request(media_type="tv", similar_to=["Dark"]), "smart")
    assert card.media.title != "Dark" and card.media.media_type == "tv"
    partial = await service.start(user, Request(similar_to=["Prest"]), "smart")
    assert isinstance(partial, ChooseReference)
    assert partial.options[0].title == "The Prestige"
    with pytest.raises(ReferenceMissing):
        await service.start(user, Request(similar_to=["no such title"]), "smart")


@pytest.mark.parametrize("title", ["Scavengers Reign", "Reign Scavenger's", "Scavenger’s Reign"])
async def test_persian_anime_request_ranks_by_shared_themes(service, title):
    user = await service.user(704)
    request = await service.interpret(user, f"یه انیمه شبیه{title}")
    assert request.genres == ["animation"]
    top = await service.start(user, request, "smart")
    assert top.media.title == "Made in Abyss"
    assert "زیست‌بوم غریب" in top.explanation
    second = await service.next(user, top.recommendation_id)
    assert second.media.title == "Nausicaä of the Valley of the Wind"


async def test_ai_success_and_known_hard_limits(service):
    async def valid(request):
        body = json.loads(request.content)
        assert body["response_format"] == {"type": "json_object"}
        assert body["max_completion_tokens"] == 200
        content = json.dumps(
            {
                "unsupported": False,
                "request": {
                    "media_type": "tv",
                    "genres": ["mystery"],
                    "max_episodes": 10,
                    "max_seasons": 1,
                },
            }
        )
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": content}}], "usage": {"total_tokens": 120}},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(valid)) as client:
        service.ai = OpenAIProvider(
            client, "https://example.invalid/v1", "placeholder", "mock", 1, 200
        )
        user = await service.user(111)
        request = await service.interpret(user, "یه مینی‌سریال معمایی با کمتر از هشت قسمت")
        assert request.max_episodes == 7
        card = await service.start(user, request, "smart")
        assert card.media.title == "Mare of Easttown"


@pytest.mark.parametrize("value", [0, -1, 2**52, True, "42"])
async def test_invalid_telegram_ids(service, value):
    with pytest.raises(ValueError):
        await service.user(value)


def test_configuration_fails_without_optional_credentials():
    with pytest.raises(ValueError):
        Settings(_env_file=None, catalog_provider="tmdb", tmdb_api_key="")
