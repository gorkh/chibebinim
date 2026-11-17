import pytest

from app.domain import Media, Request
from app.parser import NeedClarification, local_parse, preserve_bounds
from app.recommend import matches, rank, taste


def media(title, **kw):
    values = dict(
        source="test",
        external_id=title,
        media_type="movie",
        title=title,
        original_title=title,
        genres=["mystery"],
        runtime_minutes=120,
        release_year=2010,
        original_language="en",
    )
    return Media(**(values | kw))


def test_hard_filters_fail_closed():
    query = Request(
        media_type="movie",
        max_runtime_minutes=120,
        release_year_min=2000,
        genres=["mystery"],
        avoid_genres=["horror"],
        language="en",
    )
    assert matches(media("ok"), query)
    for values in [
        {"runtime_minutes": 121},
        {"runtime_minutes": None},
        {"release_year": None},
        {"release_year": 1999},
        {"genres": []},
        {"genres": ["mystery", "horror"]},
        {"media_type": "tv"},
        {"original_language": None},
    ]:
        assert not matches(media("no", **values), query), values
    assert not matches(media("unknown", media_type="tv"), Request(max_episodes=7))


def test_personalization_recent_and_reference():
    liked = media("Liked")
    a = media("A", genres=["comedy"])
    b = media("B")
    weights = (0.35, 0.25, 0.15, 0.15, 0.10)
    neutral = ({}, {}, {})
    assert rank([a, b], Request(), set(), set(), neutral, [], set(), weights)[0]["media_id"] == a.id
    profile = taste([(liked, "liked")])
    assert rank([a, b], Request(), set(), set(), profile, [], set(), weights)[0]["media_id"] == b.id
    assert (
        rank([a, b], Request(), set(), {b.id}, profile, [], set(), weights)[0]["media_id"] == a.id
    )
    assert [
        x["media_id"]
        for x in rank([a, b, liked], Request(), set(), set(), profile, [liked], set(), weights)
    ] == [b.id]


@pytest.mark.parametrize(
    ("text", "constraints"),
    [
        (
            "یه فیلم معمایی خفن می‌خوام که بیشتر از دو ساعت نباشه و خیلی ترسناک هم نباشه.",
            {"media_type": "movie", "max_runtime_minutes": 120, "avoid_genres": ["horror"]},
        ),
        ("یه فیلم هیجان‌انگیز زیر ۱۲۰ دقیقه", {"max_runtime_minutes": 119}),
        (
            "یه مینی‌سریال معمایی با کمتر از هشت قسمت پیشنهاد بده.",
            {"media_type": "tv", "max_seasons": 1, "max_episodes": 7},
        ),
        ("یه سریال شبیه Dark", {"similar_to": ["Dark"], "media_type": "tv"}),
        ("یه فیلم بعد از ۲۰۱۰", {"release_year_min": 2011}),
    ],
)
def test_persian_fallback(text, constraints):
    request, sufficient = local_parse(text)
    assert sufficient
    for key, value in constraints.items():
        assert getattr(request, key) == value


def test_unsupported_fallback_and_ai_cannot_relax_known_bound():
    assert not local_parse("کمدی بدون خشونت")[1]
    assert not local_parse("فیلم ۹۰ دقیقه")[1]
    local, _ = local_parse("فیلم زیر ۹۰ دقیقه و نه ترسناک")
    ai = Request(media_type="movie", max_runtime_minutes=120)
    combined = preserve_bounds(local, ai)
    assert combined.max_runtime_minutes == 89 and combined.avoid_genres == ["horror"]
    with pytest.raises(NeedClarification):
        preserve_bounds(local, Request(media_type="tv"))
