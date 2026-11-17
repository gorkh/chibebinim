import asyncio
import re
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, func, select, update

from app.catalog import CachedCatalog, CatalogUnavailable, normalize_title, tmdb_request_budget
from app.config import Settings
from app.db import (
    CatalogEntry,
    Event,
    Preferences,
    Recommendation,
    RecSession,
    User,
    UserMedia,
    WatchItem,
    now,
)
from app.domain import Media, Request
from app.parser import AIProvider, AIUnavailable, NeedClarification, local_parse, preserve_bounds
from app.recommend import rank, taste


def record(db, user_id: int | None, name: str, **metadata):
    db.add(Event(user_id=user_id, event_name=name, metadata_json=metadata))


class ReferenceMissing(Exception):
    pass


class StaleCard(Exception):
    pass


@dataclass(frozen=True)
class ChooseReference:
    title: str
    options: list[Media]


@dataclass(frozen=True)
class Card:
    media: Media
    explanation: str
    recommendation_id: str | None
    preference: str = "neutral"
    watched: bool = False
    saved: bool = False


class Service:
    def __init__(
        self, sessions, catalog: CachedCatalog, settings: Settings, ai: AIProvider | None = None
    ):
        self.sessions, self.catalog, self.settings, self.ai = sessions, catalog, settings, ai
        self.catalog_lock = asyncio.Lock()
        self.ai_lock = asyncio.Lock()

    async def user(
        self, telegram_id: int, *, started: bool = False, register: bool = True
    ) -> int | None:
        if type(telegram_id) is not int or not 0 < telegram_id < 2**52:
            raise ValueError("Invalid Telegram user ID")
        async with self.sessions.begin() as db:
            user = await db.scalar(select(User).where(User.telegram_id == telegram_id))
            if user is None:
                if not register:
                    return None
                user = User(telegram_id=telegram_id)
                db.add(user)
                await db.flush()
                db.add(Preferences(user_id=user.id))
            user.last_active_at = now()
            user.is_blocked = False
            if started:
                user.onboarding_completed = True
                record(db, user.id, "user_started")
            return user.id

    async def blocked(self, user: int):
        async with self.sessions.begin() as db:
            await db.execute(update(User).where(User.id == user).values(is_blocked=True))

    async def event(self, user: int | None, name: str, **metadata):
        async with self.sessions.begin() as db:
            record(db, user, name, **metadata)

    async def interpret(self, user: int, text: str) -> Request:
        local, sufficient = local_parse(text)
        if self.ai:
            async with self.ai_lock:
                async with self.sessions.begin() as db:
                    midnight = now().replace(hour=0, minute=0, second=0, microsecond=0)
                    used = await db.scalar(
                        select(func.count())
                        .select_from(Event)
                        .where(Event.event_name == "ai_request", Event.created_at >= midnight)
                    )
                    allowed = used < self.settings.ai_daily_limit
                    if allowed:
                        # Anonymous operational event; personal message and user ID are omitted.
                        record(db, None, "ai_request", operation="parse")
                if allowed:
                    try:
                        result = await self.ai.parse_user_request(text)
                    except AIUnavailable:
                        await self.event(None, "ai_request_failed")
                    else:
                        await self.event(
                            None,
                            "ai_usage",
                            operation="parse",
                            tokens=result.tokens,
                            cached=result.cached,
                        )
                        return preserve_bounds(local, result.request)
        if sufficient:
            return local
        raise NeedClarification

    async def _catalog(self, user: int, key: str, fetch):
        async with self.catalog_lock:
            try:
                async with self.sessions.begin() as db:
                    items, stale = await self.catalog.get(db, key, fetch)
            except CatalogUnavailable:
                await self.event(user, "catalog_request_failed")
                raise
            if stale:
                await self.event(user, "catalog_request_failed", used_cache=True)
            return items

    async def start(
        self, user: int, request: Request, mode: str, choices: dict[str, str] | None = None
    ) -> Card | ChooseReference | None:
        with tmdb_request_budget():
            return await self._start(user, request, mode, choices)

    async def _start(
        self, user: int, request: Request, mode: str, choices: dict[str, str] | None
    ) -> Card | ChooseReference | None:
        provider = self.catalog.provider
        references, related = [], []
        choices = choices or {}
        for title in request.similar_to:
            dated = re.fullmatch(r"(.+?)\s+(?:\(([12][0-9]{3})\)|([12][0-9]{3}))", title)
            search_title, year = (dated[1], dated[2] or dated[3]) if dated else (title, "")
            results = await self._catalog(
                user,
                f"search:{normalize_title(search_title)}",
                lambda: provider.search(search_title),
            )
            if year:
                results = [m for m in results if m.year == int(year)]
            normalized = normalize_title(search_title)
            exact = [
                m
                for m in results
                if normalized
                in {
                    normalize_title(t)
                    for t in (m.title, m.original_title, m.persian_title or "", *m.aliases)
                }
            ]
            options = exact or results
            options = list({m.id: m for m in options}.values())
            if not options:
                raise ReferenceMissing
            selected = next((m for m in options if choices.get(title) == m.id), None)
            if selected is None:
                if len(options) > 1 or not exact:
                    return ChooseReference(title, options[:8])
                selected = options[0]
            if not any(ref.id == selected.id for ref in references):
                references.append(selected)

        for index, ref in enumerate(references):
            if not ref.is_detail:

                async def detail(ref=ref):
                    media = await provider.get_details(ref.external_id, ref.media_type)
                    return [media] if media else []

                try:
                    details = await self._catalog(user, f"detail:{ref.id}", detail)
                    if details:
                        references[index] = ref = details[0]
                except CatalogUnavailable:
                    pass
            try:
                related.extend(
                    await self._catalog(user, f"related:{ref.id}", lambda: provider.similar(ref))
                )
            except CatalogUnavailable:
                # Genre overlap is still available from the verified reference.
                pass

        query = request.model_copy(update={"similar_to": [], "mood": None})
        try:
            discovered = await self._catalog(
                user, f"discover:{query.model_dump_json()}", lambda: provider.discover(query)
            )
        except CatalogUnavailable:
            if not related:
                raise
            discovered = []
        items = discovered + related
        async with self.sessions.begin() as db:
            excluded = set(
                await db.scalars(
                    select(UserMedia.media_id).where(
                        UserMedia.user_id == user,
                        UserMedia.is_watched | (UserMedia.preference == "disliked"),
                    )
                )
            )
            recent = set(
                await db.scalars(
                    select(Recommendation.media_id)
                    .where(Recommendation.user_id == user)
                    .order_by(Recommendation.recommended_at.desc())
                    .limit(self.settings.recent_recommendations_limit)
                )
            )
            profile = await db.get(Preferences, user)
            candidates = rank(
                items,
                request,
                excluded,
                recent,
                (
                    profile.genre_weights_json,
                    profile.preferred_media_types_json,
                    profile.preferred_languages_json,
                ),
                references,
                {m.id for m in related},
                self.settings.ranking_weights,
            )
            candidates = candidates[: self.settings.recommendation_candidate_limit]
            # Close earlier queues, but keep cards valid for feedback.
            await db.execute(
                update(RecSession)
                .where(RecSession.user_id == user, RecSession.expires_at > now())
                .values(expires_at=now())
            )
            if not candidates:
                record(db, user, "recommendation_no_results", mode=mode)
                return None
            document = request.model_dump(mode="json", exclude={"similar_to"})
            queue = RecSession(
                user_id=user,
                request_json=document,
                candidates=candidates,
                request_type=mode,
                expires_at=now() + timedelta(hours=24),
            )
            db.add(queue)
            await db.flush()
            return await self._advance(db, user, queue)

    async def next(self, user: int, from_rec: str) -> Card | None:
        async with self.sessions.begin() as db:
            previous = await self._owned_rec(db, user, from_rec)
            queue = await db.get(RecSession, previous.session_id)
            latest = await db.scalar(
                select(Recommendation.id)
                .where(Recommendation.session_id == queue.id)
                .order_by(Recommendation.recommended_at.desc(), Recommendation.id.desc())
                .limit(1)
            )
            if latest != from_rec or queue.expires_at <= now():
                raise StaleCard
            record(db, user, "recommendation_next_clicked")
            return await self._advance(db, user, queue)

    async def _advance(self, db, user: int, queue: RecSession) -> Card | None:
        while queue.current_position < len(queue.candidates):
            candidate = queue.candidates[queue.current_position]
            queue.current_position += 1
            mid = candidate["media_id"]
            cached = await db.get(CatalogEntry, mid)
            feedback = await db.get(UserMedia, (user, mid))
            if not cached or (
                feedback and (feedback.is_watched or feedback.preference == "disliked")
            ):
                continue
            media = Media.model_validate(cached.metadata_json)
            from app.recommend import matches

            if not matches(media, Request.model_validate(queue.request_json)):
                continue
            item = Recommendation(
                user_id=user,
                session_id=queue.id,
                request_type=queue.request_type,
                media_id=mid,
                recommendation_score=candidate["score"],
                explanation=candidate["explanation"],
            )
            db.add(item)
            record(db, user, "recommendation_generated", mode=queue.request_type)
            await db.flush()
            return await self._card(db, user, cached, item)
        queue.expires_at = now()
        return None

    async def _owned_rec(self, db, user: int, rec_id: str) -> Recommendation:
        rec = await db.get(Recommendation, rec_id)
        if rec is None or rec.user_id != user:
            raise StaleCard
        return rec

    async def _card(self, db, user: int, cached: CatalogEntry, rec: Recommendation | None) -> Card:
        state = await db.get(UserMedia, (user, cached.id))
        return Card(
            Media.model_validate(cached.metadata_json),
            rec.explanation if rec else "",
            rec.id if rec else None,
            state.preference if state else "neutral",
            bool(state and state.is_watched),
            bool(await db.get(WatchItem, (user, cached.id))),
        )

    async def card(self, user: int, key: str, watchlist: bool = False) -> Card:
        async with self.sessions() as db:
            rec = None if watchlist else await self._owned_rec(db, user, key)
            mid = rec.media_id if rec else key
            cached = await db.get(CatalogEntry, mid)
            if not cached or (watchlist and not await db.get(WatchItem, (user, mid))):
                raise StaleCard
            return await self._card(db, user, cached, rec)

    async def feedback(self, user: int, rec_id: str, action: str) -> Card:
        if action not in {"liked", "disliked", "watched", "save"}:
            raise StaleCard
        async with self.sessions.begin() as db:
            rec = await self._owned_rec(db, user, rec_id)
            mid = rec.media_id
            cached = await db.get(CatalogEntry, mid)
            if action == "save":
                if not await db.get(WatchItem, (user, mid)):
                    db.add(WatchItem(user_id=user, media_id=mid))
                    record(db, user, "watchlist_added")
            else:
                state = await db.get(UserMedia, (user, mid))
                if state is None:
                    state = UserMedia(
                        user_id=user, media_id=mid, preference="neutral", is_watched=False
                    )
                    db.add(state)
                if action == "watched":
                    if not state.is_watched:
                        state.is_watched, state.watched_at = True, now()
                        record(db, user, "movie_watched")
                elif state.preference != action:
                    state.preference = action
                    record(db, user, f"movie_{action}")
                    await db.flush()
                    await self._rebuild_taste(db, user)
            await db.flush()
            return await self._card(db, user, cached, rec)

    async def _rebuild_taste(self, db, user):
        rows = await db.execute(
            select(CatalogEntry.metadata_json, UserMedia.preference)
            .join(UserMedia, CatalogEntry.id == UserMedia.media_id)
            .where(UserMedia.user_id == user, UserMedia.preference != "neutral")
        )
        profile = await db.get(Preferences, user)
        (
            profile.genre_weights_json,
            profile.preferred_media_types_json,
            profile.preferred_languages_json,
        ) = taste([(Media.model_validate(document), pref) for document, pref in rows])

    async def watchlist(self, user: int, page: int) -> tuple[list[Media], int, int]:
        async with self.sessions() as db:
            count = await db.scalar(
                select(func.count()).select_from(WatchItem).where(WatchItem.user_id == user)
            )
            pages = max(1, (count + 4) // 5)
            page = min(max(page, 0), pages - 1)
            entries = await db.scalars(
                select(CatalogEntry.metadata_json)
                .join(WatchItem, WatchItem.media_id == CatalogEntry.id)
                .where(WatchItem.user_id == user)
                .order_by(WatchItem.created_at.desc(), WatchItem.media_id)
                .offset(page * 5)
                .limit(5)
            )
            return [Media.model_validate(item) for item in entries], page, pages

    async def remove_watch(self, user: int, mid: str):
        async with self.sessions.begin() as db:
            result = await db.execute(
                delete(WatchItem).where(WatchItem.user_id == user, WatchItem.media_id == mid)
            )
            if result.rowcount:
                record(db, user, "watchlist_removed")

    async def profile(self, user: int) -> tuple[dict, dict, int, int, int]:
        async with self.sessions() as db:
            profile = await db.get(Preferences, user)
            rows = list(await db.scalars(select(UserMedia).where(UserMedia.user_id == user)))
            saved = await db.scalar(
                select(func.count()).select_from(WatchItem).where(WatchItem.user_id == user)
            )
            return (
                profile.genre_weights_json,
                profile.preferred_media_types_json,
                sum(r.preference == "liked" for r in rows),
                sum(r.is_watched for r in rows),
                saved,
            )

    async def reset_taste(self, user: int):
        async with self.sessions.begin() as db:
            await db.execute(
                update(UserMedia).where(UserMedia.user_id == user).values(preference="neutral")
            )
            await self._rebuild_taste(db, user)

    async def delete_user(self, user: int):
        async with self.sessions.begin() as db:
            await db.execute(delete(User).where(User.id == user))
