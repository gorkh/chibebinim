from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

from app.catalog import CachedCatalog, FixtureProvider
from app.config import Settings
from app.db import engine_for, sessions_for
from app.service import Service

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def database_url(monkeypatch, tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path.joinpath('test.db').as_posix()}"
    monkeypatch.setenv("DATABASE_URL", url)
    alembic = Config(str(ROOT / "alembic.ini"))
    command.upgrade(alembic, "head")
    return url


@pytest.fixture
async def service(database_url):
    settings = Settings(
        _env_file=None, database_url=database_url, ai_enabled=False, catalog_provider="fixture"
    )
    engine = engine_for(database_url)
    try:
        yield Service(
            sessions_for(engine), CachedCatalog(FixtureProvider(), 168, "fixture"), settings
        )
    finally:
        await engine.dispose()
