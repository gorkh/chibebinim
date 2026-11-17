import asyncio
import hashlib
import logging
import re
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import timedelta
from importlib.resources import files
from typing import Protocol

import httpx
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import CatalogEntry, CatalogQuery, now
from app.domain import Media, MediaType, Request

log = logging.getLogger(__name__)


class CatalogUnavailable(Exception):
    pass


TMDB_REQUEST_LIMIT = 38
TMDB_DETAIL_LIMIT = 12
_tmdb_attempts: ContextVar[list[int] | None] = ContextVar("tmdb_attempts", default=None)


@contextmanager
def tmdb_request_budget():
    # Child tasks from gather share the counter, while concurrent requests have separate budgets.
    marker = _tmdb_attempts.set([0])
    try:
        yield
    finally:
        _tmdb_attempts.reset(marker)


class MovieCatalogProvider(Protocol):
    async def search(self, query: str) -> list[Media]: ...
    async def discover(self, request: Request) -> list[Media]: ...
    async def get_details(self, media_id: str, media_type: MediaType) -> Media | None: ...
    async def similar(self, media: Media) -> list[Media]: ...


class FixtureProvider:
    def __init__(self):
        raw = files("app").joinpath("catalog.json").read_text(encoding="utf-8")
        self.items = TypeAdapter(list[Media]).validate_json(raw)
        self.cache_version = hashlib.sha256(raw.encode()).hexdigest()

    async def search(self, query: str) -> list[Media]:
        normalized = normalize_title(query)
        return [
            m
            for m in self.items
            if any(
                normalized in normalize_title(t)
                for t in (m.title, m.original_title, m.persian_title or "", *m.aliases)
            )
        ]

    async def discover(self, request: Request) -> list[Media]:
        return [
            m for m in self.items if not request.media_type or m.media_type == request.media_type
        ]

    async def get_details(self, media_id: str, media_type: MediaType) -> Media | None:
        return next(
            (m for m in self.items if m.external_id == media_id and m.media_type == media_type),
            None,
        )

    async def similar(self, media: Media) -> list[Media]:
        return [m for m in self.items if m.id != media.id and set(m.genres) & set(media.genres)]


def normalize_title(title: str) -> str:
    title = title.replace("’", "").replace("'", "")
    return " ".join(re.sub(r"[\W_]+", " ", title.casefold()).split())


IDS = {
    9648: ("mystery",),
    53: ("thriller",),
    35: ("comedy",),
    28: ("action",),
    878: ("science_fiction",),
    27: ("horror",),
    10749: ("romance",),
    18: ("drama",),
    80: ("crime",),
    14: ("fantasy",),
    12: ("adventure",),
    16: ("animation",),
    99: ("documentary",),
    10751: ("family",),
    36: ("history",),
    10402: ("music",),
    10752: ("war",),
    37: ("western",),
    10759: ("action", "adventure"),
    10765: ("science_fiction", "fantasy"),
    10768: ("war", "politics"),
    10762: ("kids",),
    10763: ("news",),
    10764: ("reality",),
    10766: ("soap",),
    10767: ("talk",),
}
# TMDB's series taxonomy groups some categories and has no dedicated horror/thriller tag.
TV_IDS = {
    k: [
        gid
        for gid, names in IDS.items()
        if k in names and gid not in {53, 28, 878, 27, 10749, 14, 12, 36, 10402, 10752}
    ]
    for k in set(sum(IDS.values(), ()))
}


class TMDBProvider:
    cache_version = "shortlist-v1"

    def __init__(self, client: httpx.AsyncClient, base: str, key: str, limit: int):
        self.client, self.base, self.key, self.limit = client, base.rstrip("/"), key, limit
        self.slots = asyncio.Semaphore(6)
        self.curated = FixtureProvider().items

    def _with_themes(self, media: Media) -> Media:
        match = next(
            (
                item
                for item in self.curated
                if item.media_type == media.media_type
                and item.year == media.year
                and normalize_title(item.title) == normalize_title(media.title)
            ),
            None,
        )
        if match is None:
            return media
        return media.model_copy(update={"themes": match.themes, "aliases": match.aliases})

    async def _get(self, path: str, **params) -> dict | None:
        headers = {}
        if len(self.key) == 32 and re.fullmatch(r"[a-fA-F0-9]+", self.key):
            params["api_key"] = self.key
        else:
            headers["Authorization"] = f"Bearer {self.key}"
        for attempt in range(2):
            try:
                async with self.slots:
                    used = _tmdb_attempts.get()
                    if used is not None:
                        if used[0] >= TMDB_REQUEST_LIMIT:
                            raise CatalogUnavailable
                        used[0] += 1
                    response = await self.client.get(
                        f"{self.base}/{path}", params=params, headers=headers, timeout=4
                    )
                if response.status_code == 404:
                    return None
                response.raise_for_status()
                value = response.json()
                if not isinstance(value, dict):
                    raise ValueError("Invalid catalog response")
                return value
            except httpx.HTTPStatusError as error:
                status = error.response.status_code
                if attempt or (status != 429 and status < 500):
                    raise CatalogUnavailable from None
                try:
                    delay = float(response.headers.get("Retry-After", "0.3"))
                except ValueError:
                    delay = 0.3
                await asyncio.sleep(max(0.3, min(delay, 2)))
            except httpx.TimeoutException:
                if attempt:
                    raise CatalogUnavailable from None
                await asyncio.sleep(0.3)
            except (httpx.HTTPError, ValueError):
                raise CatalogUnavailable from None
        raise CatalogUnavailable

    @staticmethod
    def _media(row: dict, kind: MediaType, *, is_detail: bool = False) -> Media | None:
        try:
            if row.get("adult"):
                return None
            title = row.get("title") if kind == "movie" else row.get("name")
            original = row.get("original_title") if kind == "movie" else row.get("original_name")
            translation = next(
                (
                    t.get("data", {})
                    for t in row.get("translations", {}).get("translations", [])
                    if t.get("iso_639_1") == "fa"
                ),
                {},
            )
            poster = row.get("poster_path") or ""
            genre_ids = row.get("genre_ids", [g["id"] for g in row.get("genres", [])])
            keyword_rows = (row.get("keywords") or {}).get(
                "keywords" if kind == "movie" else "results", []
            )
            return Media(
                source="tmdb",
                external_id=str(row["id"]),
                media_type=kind,
                title=title or original,
                original_title=original or title,
                persian_title=translation.get("title") or translation.get("name") or None,
                overview_fa=translation.get("overview") or None,
                overview_en=row.get("overview") or None,
                genres=list(dict.fromkeys(g for gid in genre_ids for g in IDS.get(gid, ()))),
                release_date=row.get("release_date" if kind == "movie" else "first_air_date")
                or None,
                runtime_minutes=(row.get("runtime") or None) if kind == "movie" else None,
                seasons_count=row.get("number_of_seasons") or None,
                episodes_count=row.get("number_of_episodes") or None,
                status=row.get("status"),
                rating_source="TMDB",
                vote_average=row.get("vote_average") if row.get("vote_count") else None,
                vote_count=row.get("vote_count"),
                poster_path=f"https://image.tmdb.org/t/p/w500{poster}"
                if re.fullmatch(r"/[\w.-]+", poster)
                else None,
                original_language=row.get("original_language") or None,
                popularity=row.get("popularity"),
                source_url=f"https://www.themoviedb.org/{kind}/{int(row['id'])}",
                is_detail=is_detail,
                keywords=[entry["name"] for entry in keyword_rows if entry.get("name")],
            )
        except (ValidationError, KeyError, TypeError, ValueError, AttributeError):
            return None

    def _results(self, data: dict | None, kind: MediaType) -> list[Media]:
        return [
            self._with_themes(m)
            for row in (data or {}).get("results", [])
            if isinstance(row, dict) and (m := self._media(row, kind))
        ]

    async def search(self, query: str) -> list[Media]:
        normalized = normalize_title(query)
        canonical = {
            m.title
            for m in self.curated
            if normalized in {normalize_title(alias) for alias in m.aliases}
        }
        if len(canonical) == 1:
            query = canonical.pop()
        pairs = await asyncio.gather(
            *(
                self._get(f"search/{kind}", query=query, include_adult="false", language="en-US")
                for kind in ("movie", "tv")
            )
        )
        return self._results(pairs[0], "movie") + self._results(pairs[1], "tv")

    async def get_details(self, media_id: str, media_type: MediaType) -> Media | None:
        if not media_id.isascii() or not media_id.isdigit():
            return None
        data = await self._get(
            f"{media_type}/{media_id}", language="en-US", append_to_response="translations,keywords"
        )
        media = self._media(data, media_type, is_detail=True) if data else None
        return self._with_themes(media) if media else None

    async def _hydrate(self, items: list[Media], request: Request | None = None) -> list[Media]:
        from app.recommend import rank

        if request:
            # Detail-only fields are verified by the engine after hydration.
            partial = request.model_copy(
                update=dict(
                    min_runtime_minutes=None,
                    max_runtime_minutes=None,
                    max_episodes=None,
                    max_seasons=None,
                )
            )
            by_id = {item.id: item for item in items}
            scored = rank(
                items,
                partial,
                set(),
                set(),
                ({}, {}, {}),
                [],
                set(),
                (0.35, 0.25, 0.15, 0.15, 0.10),
            )
            items = [by_id[row["media_id"]] for row in scored]

        async def hydrate(m: Media) -> Media | None:
            return await self.get_details(m.external_id, m.media_type)

        # Hydrate only the shortlist. The final filter still verifies runtime and episode counts.
        shortlist = items[: min(self.limit, TMDB_DETAIL_LIMIT)]
        return [m for m in await asyncio.gather(*(hydrate(m) for m in shortlist)) if m]

    async def discover(self, request: Request) -> list[Media]:
        async def one(kind: MediaType) -> list[Media]:
            date_field = "primary_release_date" if kind == "movie" else "first_air_date"
            params = {"include_adult": "false", "language": "en-US", "sort_by": "popularity.desc"}
            if request.release_year_min:
                params[f"{date_field}.gte"] = f"{request.release_year_min}-01-01"
            if request.release_year_max:
                params[f"{date_field}.lte"] = f"{request.release_year_max}-12-31"
            if request.language:
                params["with_original_language"] = request.language
            if kind == "movie":
                if request.max_runtime_minutes:
                    params["with_runtime.lte"] = request.max_runtime_minutes
                if request.min_runtime_minutes:
                    params["with_runtime.gte"] = request.min_runtime_minutes
            ids = [
                gid
                for g in request.genres
                for gid in (
                    TV_IDS.get(g, [])
                    if kind == "tv"
                    else [i for i, names in IDS.items() if len(names) == 1 and g in names]
                )
            ]
            if ids and (kind == "movie" or all(TV_IDS.get(g) for g in request.genres)):
                params["with_genres"] = "|".join(map(str, sorted(set(ids))))
            data = await self._get(f"discover/{kind}", **params)
            items = self._results(data, kind)
            for page in range(2, min(3, (data or {}).get("total_pages", 1)) + 1):
                if len(items) >= min(self.limit, TMDB_DETAIL_LIMIT) * 2:
                    break
                items.extend(
                    self._results(await self._get(f"discover/{kind}", page=page, **params), kind)
                )
            return items

        if request.media_type:
            items = await one(request.media_type)
        else:
            movies, tv = await asyncio.gather(one("movie"), one("tv"))
            items = sorted(movies + tv, key=lambda m: m.popularity or 0, reverse=True)
        return await self._hydrate(items, request)

    async def similar(self, media: Media) -> list[Media]:
        async def curated_match(item: Media) -> Media | None:
            rows = await self._get(
                f"search/{item.media_type}",
                query=item.title,
                language="en-US",
                include_adult="false",
            )
            return next(
                (
                    m
                    for m in self._results(rows, item.media_type)
                    if m.year == item.year
                    and normalize_title(m.title) == normalize_title(item.title)
                ),
                None,
            )

        data = await self._get(
            f"{media.media_type}/{media.external_id}/recommendations", language="en-US"
        )
        themed = [
            item
            for item in self.curated
            if set(item.themes).intersection(media.themes) and item.title != media.title
        ]
        themed.sort(key=lambda item: -len(set(item.themes).intersection(media.themes)))
        matches = await asyncio.gather(*(curated_match(item) for item in themed[:4]))
        candidates = [m for m in matches if m] + self._results(data, media.media_type)[:10]
        return await self._hydrate(list({m.id: m for m in candidates}.values()))


async def save_media(db: AsyncSession, media: Media) -> None:
    row = await db.get(CatalogEntry, media.id)
    document = media.model_dump(mode="json")
    if row is None:
        db.add(
            CatalogEntry(
                id=media.id,
                source=media.source,
                external_id=media.external_id,
                media_type=media.media_type,
                metadata_json=document,
            )
        )
    elif media.is_detail or not row.metadata_json.get("is_detail", True):
        # Authoritative refreshes may clear fields; search summaries cannot erase details.
        row.metadata_json, row.metadata_updated_at = document, now()


class CachedCatalog:
    def __init__(self, provider: MovieCatalogProvider, ttl_hours: int, namespace: str):
        self.provider = provider
        self.ttl = timedelta(hours=ttl_hours)
        self.namespace = namespace

    async def get(
        self, db: AsyncSession, key: str, fetch: Callable[[], Awaitable[list[Media]]]
    ) -> tuple[list[Media], bool]:
        version = getattr(self.provider, "cache_version", "")
        if version:
            key = f"{version}:{key}"
        digest = hashlib.sha256(f"{self.namespace}:{key}".encode()).hexdigest()
        query = await db.get(CatalogQuery, digest)

        async def stored() -> list[Media]:
            entries = [await db.get(CatalogEntry, pk) for pk in query.media_ids]
            return [Media.model_validate(row.metadata_json) for row in entries if row]

        if query and now() - query.fetched_at < self.ttl:
            return await stored(), False
        try:
            async with asyncio.timeout(15):
                items = await fetch()
        except (CatalogUnavailable, TimeoutError, TypeError, ValueError, AttributeError):
            log.warning("event=catalog_request_failed provider=%s", self.namespace)
            if query:
                return await stored(), True
            raise CatalogUnavailable from None
        for media in {m.id: m for m in items}.values():
            await save_media(db, media)
        if query:
            query.fetched_at, query.media_ids = now(), [m.id for m in items]
        else:
            db.add(CatalogQuery(key=digest, fetched_at=now(), media_ids=[m.id for m in items]))
        await db.flush()
        return items, False
