import asyncio

import httpx

from app.catalog import (
    TMDB_DETAIL_LIMIT,
    TMDB_REQUEST_LIMIT,
    CatalogUnavailable,
    TMDBProvider,
    tmdb_request_budget,
)
from app.domain import Request
from app.recommend import matches, rank


async def test_tmdb_discover_verifies_runtime_and_retries():
    calls = []
    basics = {
        "title": "Test",
        "original_title": "Test",
        "genre_ids": [9648],
        "release_date": "2020-09-09",
        "original_language": "en",
        "vote_count": 0,
    }

    async def send(req):
        calls.append(req)
        suffix = req.url.path.removeprefix("/3/")
        assert req.headers["Authorization"] == "Bearer placeholder"
        if suffix == "discover/movie":
            assert req.url.params["with_runtime.lte"] == "120"
            if len(calls) == 1:
                return httpx.Response(429, headers={"Retry-After": "0"})
            return httpx.Response(200, json={"results": [basics | {"id": i} for i in (1, 2, 3)]})
        kind, id_ = suffix.split("/")
        assert kind == "movie"
        runtime = {"1": 120, "2": 121, "3": None}[id_]
        return httpx.Response(200, json=basics | {"id": int(id_), "runtime": runtime})

    async with httpx.AsyncClient(transport=httpx.MockTransport(send)) as client:
        provider = TMDBProvider(client, "https://example.invalid/3", "placeholder", 5)
        query = Request(media_type="movie", genres=["mystery"], max_runtime_minutes=120)
        rows = await provider.discover(query)
    assert len(rows) == 3
    assert [m.external_id for m in rows if matches(m, query)] == ["1"]
    assert all(m.vote_average is None for m in rows)


def test_reference_keywords_outweigh_genre_and_provider_recommendation():
    def show(title, external_id, tags, genres):
        return TMDBProvider._media(
            {
                "id": external_id,
                "name": title,
                "genre_ids": genres,
                "keywords": {"results": [{"name": tag} for tag in tags]},
                "vote_count": 500,
                "vote_average": 8.5,
            },
            "tv",
        )

    ref = show("Reference", 1, ["alien planet", "survival", "anime"], [16, 10765])
    weak = show("Same genres", 2, ["anime"], [16, 10765])
    strong = show("Same setting", 3, ["alien planet", "survival"], [16, 10759])
    ranked = rank(
        [weak, strong],
        Request(genres=["animation"]),
        set(),
        set(),
        ({}, {}, {}),
        [ref],
        {weak.id},
        (0.35, 0.25, 0.15, 0.15, 0.10),
    )
    assert ranked[0]["media_id"] == strong.id
    assert "alien planet" in ranked[0]["explanation"]


async def test_cold_discovery_shortlists_and_budget_covers_parallel_calls():
    requested = []
    base = {"title": "Test", "genre_ids": [53], "vote_average": 7, "vote_count": 100}

    async def send(request):
        requested.append(request.url.path)
        if request.url.path.endswith("/discover/movie"):
            return httpx.Response(200, json={"results": [base | {"id": i} for i in range(1, 21)]})
        return httpx.Response(200, json=base | {"id": int(request.url.path.rsplit("/", 1)[-1])})

    async with httpx.AsyncClient(transport=httpx.MockTransport(send)) as client:
        provider = TMDBProvider(client, "https://example.invalid/3", "placeholder", 50)
        with tmdb_request_budget():
            result = await provider.discover(Request(media_type="movie", genres=["thriller"]))
            assert len(result) == TMDB_DETAIL_LIMIT
            initial = len(requested)
            assert initial == 1 + TMDB_DETAIL_LIMIT
            rest = await asyncio.gather(
                *(provider.get_details(str(i), "movie") for i in range(1, 51)),
                return_exceptions=True,
            )
            assert len(requested) == TMDB_REQUEST_LIMIT
            assert all(
                isinstance(error, CatalogUnavailable)
                for error in rest[TMDB_REQUEST_LIMIT - initial :]
            )
        with tmdb_request_budget():
            assert await provider.get_details("1", "movie")
