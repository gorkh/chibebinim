from collections import Counter

from app.domain import GENRES, Media, Request


def matches(media: Media, request: Request) -> bool:
    genres = set(media.genres)
    if request.media_type and media.media_type != request.media_type:
        return False
    if "animation" in request.genres and "animation" not in genres:
        return False
    requested_genres = set(request.genres) - {"animation"}
    if requested_genres and not genres.intersection(requested_genres):
        return False
    if request.avoid_genres:
        # TMDB's TV genres cannot rule out every movie genre (e.g. horror).
        if media.source == "tmdb" and media.media_type == "tv":
            from app.catalog import TV_IDS

            if any(not TV_IDS.get(g) for g in request.avoid_genres):
                return False
        if not genres or genres.intersection(request.avoid_genres):
            return False
    if request.language and media.original_language != request.language:
        return False
    for bound, value, lower in (
        (request.min_runtime_minutes, media.runtime_minutes, True),
        (request.max_runtime_minutes, media.runtime_minutes, False),
        (request.release_year_min, media.year, True),
        (request.release_year_max, media.year, False),
        (request.max_episodes, media.episodes_count, False),
        (request.max_seasons, media.seasons_count, False),
        (request.min_rating, media.vote_average, True),
    ):
        if bound is not None and (value is None or (value < bound if lower else value > bound)):
            return False
    return True


def taste(rows: list[tuple[Media, str]]) -> tuple[dict, dict, dict]:
    genres, types, languages = Counter(), Counter(), Counter()
    for media, feedback in rows:
        weight = 1 if feedback == "liked" else -0.35
        for genre in media.genres:
            genres[genre] += weight
        types[media.media_type] += weight
        if media.original_language:
            languages[media.original_language] += weight
    return tuple(
        {k: max(-3.0, min(3.0, v)) for k, v in table.items()}
        for table in (genres, types, languages)
    )


MOOD_PROXY = {
    "dark": {"crime", "mystery", "thriller", "horror"},
    "intense": {"action", "thriller", "crime", "horror"},
    "light": {"comedy", "family", "animation"},
    "uplifting": {"comedy", "family", "adventure"},
}
GENERIC_KEYWORDS = {
    "anime",
    "animation",
    "based on manga",
    "based on novel or book",
    "adult animation",
}


def rank(
    items: list[Media],
    request: Request,
    excluded: set[str],
    recent: set[str],
    preferences: tuple[dict, dict, dict],
    references: list[Media],
    related: set[str],
    weights: tuple[float, ...],
) -> list[dict]:
    scores = []
    genres, types, languages = preferences
    ref_ids = {ref.id for ref in references}
    for media in {m.id: m for m in items}.values():
        if media.id in excluded | ref_ids or not matches(media, request):
            continue
        labels = set(media.genres)
        targeted = set(request.genres) | MOOD_PROXY.get(request.mood, set())
        similarity = 0.0
        shared_themes: list[str] = []
        shared_keywords: list[str] = []
        keywords = {keyword.casefold() for keyword in media.keywords} - GENERIC_KEYWORDS
        for ref in references:
            overlap = sorted(set(media.themes) & set(ref.themes))
            reference_keywords = {keyword.casefold() for keyword in ref.keywords} - GENERIC_KEYWORDS
            keyword_overlap = sorted(keywords & reference_keywords)
            genre_score = len(labels & set(ref.genres)) / max(1, len(labels | set(ref.genres)))
            score = genre_score
            if ref.themes or reference_keywords:
                thematic = len(overlap) / max(1, len(set(ref.themes)))
                keyword_score = len(keyword_overlap) / max(1, len(reference_keywords))
                score = 0.2 * genre_score + 0.8 * max(thematic, keyword_score)
            if score > similarity:
                similarity, shared_themes, shared_keywords = score, overlap, keyword_overlap
        if media.id in related and media.source == "tmdb":
            similarity += 0.05 * (1 - similarity)
        if references and not similarity:
            continue
        quality = ((media.vote_average or 0) * (media.vote_count or 0) + 600) / (
            10 * ((media.vote_count or 0) + 100)
        )
        signals = (
            len(labels & targeted) / len(targeted) if targeted else None,
            (
                3
                + (
                    0.7 * sum(genres.get(g, 0) for g in labels) / max(1, len(labels))
                    + 0.2 * types.get(media.media_type, 0)
                    + 0.1 * languages.get(media.original_language, 0)
                )
            )
            / 6
            if any(preferences)
            else None,
            quality,
            similarity if references else None,
            1.0 if media.id not in recent else 0.0,
        )
        ranking_weights = (*weights[:3], weights[3] * 4, weights[4]) if references else weights
        active = [
            (weight, signal)
            for weight, signal in zip(ranking_weights, signals, strict=True)
            if signal is not None
        ]
        score = sum(w * v for w, v in active) / sum(w for w, _ in active)
        preferred = sorted(
            (g for g in labels if genres.get(g, 0) > 0), key=genres.get, reverse=True
        )
        selected = sorted(labels & set(request.genres))
        shared = sorted(labels & {g for ref in references for g in ref.genres})
        if shared_themes:
            themes = " و ".join(f"«{theme}»" for theme in shared_themes[:2])
            reason = f"مثل عنوان مرجع، سراغ {themes} می‌ره."
        elif shared_keywords:
            tags = " و ".join(f"«\u2066{tag}\u2069»" for tag in shared_keywords[:2])
            reason = f"با عنوان مرجع در این برچسب‌های داستانی مشترکه: {tags}"
        elif shared:
            reason = f"با عنوان مرجع، ژانر «{GENRES[shared[0]]}» رو مشترک داره."
        elif references:
            reason = "کاتالوگ این عنوان رو در پیشنهادهای مرتبط با عنوان مرجع آورده."
        elif preferred:
            reason = f"چون قبلاً از آثار «{GENRES[preferred[0]]}» خوشت اومده، شاید اینم بپسندی."
        elif selected:
            reason = f"با ژانر «{GENRES[selected[0]]}» که خواستی جور درمیاد."
        elif request.max_runtime_minutes:
            reason = "مدتش در بازه‌ایه که خواستی."
        elif labels & MOOD_PROXY.get(request.mood, set()):
            g = sorted(labels & MOOD_PROXY[request.mood])[0]
            reason = f"ژانر «{GENRES[g]}» ممکنه به حال‌وهوایی که گفتی نزدیک باشه."
        else:
            reason = "این عنوان با شرط‌هایی که انتخاب کردی جور درمیاد."
        scores.append(
            (media.id in recent, -score, -(media.popularity or 0), media.title, media.id, reason)
        )
    return [
        dict(media_id=mid, score=-score, explanation=reason)
        for _, score, _, _, mid, reason in sorted(scores)
    ]
