from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    telegram_bot_token: SecretStr = SecretStr("")
    database_url: str = "sqlite+aiosqlite:///./data/moviebot.db"
    catalog_provider: Literal["fixture", "tmdb"] = "fixture"
    tmdb_api_key: SecretStr = SecretStr("")
    tmdb_api_base_url: AnyHttpUrl = AnyHttpUrl("https://api.themoviedb.org/3")
    tmdb_logo_url: AnyHttpUrl | None = None
    ai_enabled: bool = False
    ai_provider: Literal["openai"] = "openai"
    ai_api_key: SecretStr = SecretStr("")
    ai_base_url: AnyHttpUrl = AnyHttpUrl("https://api.openai.com/v1")
    ai_model: str = ""
    ai_timeout: float = Field(7, gt=0, le=30)
    ai_max_output_tokens: int = Field(500, ge=100, le=2000)
    ai_daily_limit: int = Field(250, ge=1)
    ccloud_base_url: AnyHttpUrl = AnyHttpUrl("https://ccloud.sbs/")
    telegram_native_copy: bool = True
    recommendation_candidate_limit: int = Field(50, ge=5, le=100)
    recent_recommendations_limit: int = Field(30, ge=0, le=100)
    cache_ttl_hours: int = Field(168, ge=1)
    ranking_weights: tuple[float, float, float, float, float] = (0.35, 0.25, 0.15, 0.15, 0.10)

    @model_validator(mode="after")
    def credentials(self):
        if self.catalog_provider == "tmdb" and not self.tmdb_api_key.get_secret_value():
            raise ValueError("TMDB_API_KEY is required for TMDB")
        if self.ai_enabled and not (self.ai_api_key.get_secret_value() and self.ai_model):
            raise ValueError("AI_API_KEY and AI_MODEL are required when AI is enabled")
        if any(not 0 < weight <= 1 for weight in self.ranking_weights):
            raise ValueError("Ranking weights must be in (0, 1]")
        return self
