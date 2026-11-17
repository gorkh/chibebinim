from datetime import date
from typing import Annotated, Literal
from uuid import NAMESPACE_URL, uuid5

from pydantic import BaseModel, ConfigDict, Field, model_validator

MediaType = Literal["movie", "tv"]
Genre = Literal[
    "mystery",
    "thriller",
    "comedy",
    "action",
    "science_fiction",
    "horror",
    "romance",
    "drama",
    "crime",
    "fantasy",
    "adventure",
    "animation",
    "documentary",
    "family",
    "history",
    "music",
    "war",
    "western",
    "reality",
    "kids",
    "news",
    "soap",
    "talk",
    "politics",
]
GENRES = dict(
    zip(
        (
            "mystery",
            "thriller",
            "comedy",
            "action",
            "science_fiction",
            "horror",
            "romance",
            "drama",
            "crime",
            "fantasy",
            "adventure",
            "animation",
            "documentary",
            "family",
            "history",
            "music",
            "war",
            "western",
            "reality",
            "kids",
            "news",
            "soap",
            "talk",
            "politics",
        ),
        (
            "معمایی",
            "هیجان‌انگیز",
            "کمدی",
            "اکشن",
            "علمی‌تخیلی",
            "ترسناک",
            "عاشقانه",
            "درام",
            "جنایی",
            "فانتزی",
            "ماجراجویی",
            "انیمیشن",
            "مستند",
            "خانوادگی",
            "تاریخی",
            "موسیقی",
            "جنگی",
            "وسترن",
            "واقع‌نما",
            "کودک",
            "خبر",
            "ملودرام",
            "گفت‌وگو",
            "سیاسی",
        ),
        strict=True,
    )
)
QUICK_GENRES = list(GENRES)[:10]

Positive = Annotated[int, Field(ge=1, le=10000)]
Year = Annotated[int, Field(ge=1870, le=2100)]
Language = Annotated[str, Field(pattern=r"^[a-z]{2}$")]
Title = Annotated[str, Field(min_length=1, max_length=140)]


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)

    media_type: MediaType | None = None
    genres: list[Genre] = Field(default_factory=list, max_length=10)
    avoid_genres: list[Genre] = Field(default_factory=list, max_length=10)
    min_runtime_minutes: Positive | None = None
    max_runtime_minutes: Positive | None = None
    release_year_min: Year | None = None
    release_year_max: Year | None = None
    max_episodes: Positive | None = None
    max_seasons: Positive | None = None
    min_rating: Annotated[float, Field(ge=0, le=10)] | None = None
    similar_to: list[Title] = Field(default_factory=list, max_length=3)
    language: Language | None = None
    mood: Literal["intense", "light", "dark", "uplifting"] | None = None

    @model_validator(mode="after")
    def ranges(self):
        for low, high in [
            (self.min_runtime_minutes, self.max_runtime_minutes),
            (self.release_year_min, self.release_year_max),
        ]:
            if low is not None and high is not None and low > high:
                raise ValueError("Contradictory bounds")
        if set(self.genres) & set(self.avoid_genres):
            raise ValueError("Contradictory genres")
        return self


class Media(BaseModel):
    source: str
    external_id: str
    media_type: MediaType
    title: str = Field(min_length=1)
    original_title: str = Field(min_length=1)
    persian_title: str | None = None
    overview_fa: str | None = None
    overview_en: str | None = None
    release_date: date | None = None
    release_year: Year | None = None
    genres: list[Genre] = Field(default_factory=list)
    runtime_minutes: Positive | None = None
    seasons_count: Positive | None = None
    episodes_count: Positive | None = None
    status: str | None = None
    rating_source: str | None = None
    vote_average: Annotated[float, Field(ge=0, le=10)] | None = None
    vote_count: Annotated[int, Field(ge=0)] | None = None
    poster_path: str | None = None
    original_language: Language | None = None
    popularity: float | None = None
    source_url: str | None = None
    aliases: list[str] = Field(default_factory=list)
    themes: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    is_detail: bool = True

    @property
    def id(self) -> str:
        key = f"{self.source}:{self.media_type}:{self.external_id}"
        return uuid5(NAMESPACE_URL, key).hex

    @property
    def year(self) -> int | None:
        return self.release_date.year if self.release_date else self.release_year
