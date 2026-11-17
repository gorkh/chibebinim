"""Create and verify a private SQLite snapshot and a D1-compatible import file."""

import argparse
import json
import sqlite3
from pathlib import Path

from sqlalchemy.engine import make_url

from app.config import Settings

# Imported in foreign-key order. The query cache can be rebuilt from TMDB.
TABLES = (
    "users",
    "media",
    "user_media_interactions",
    "watchlist",
    "user_preferences",
    "recommendation_sessions",
    "recommendations",
    "analytics_events",
)


def snapshot(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)
    if destination.exists():
        raise FileExistsError(destination)
    with sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True) as db:
        with sqlite3.connect(destination) as copy:
            # The SQLite backup API includes transactions committed in the WAL.
            db.backup(copy)


def dump(db: sqlite3.Connection, output: Path) -> dict[str, int]:
    counts = {}
    with output.open("x", encoding="utf-8", newline="\n") as file:
        file.write("-- Private D1 import. Apply the Cloudflare bot schema first.\n")
        for table in TABLES:
            columns = [column[1] for column in db.execute(f'PRAGMA table_info("{table}")')]
            if not columns:
                raise ValueError(f"Missing table: {table}")
            quoted = ", ".join(f'"{name}"' for name in columns)
            select = ", ".join(f'quote("{name}")' for name in columns)
            count = 0
            for values in db.execute(f'SELECT {select} FROM "{table}"'):
                file.write(f'INSERT INTO "{table}" ({quoted}) VALUES ({", ".join(values)});\n')
                count += 1
            counts[table] = count
    return counts


def verify(original: sqlite3.Connection, sql: Path, counts: dict[str, int]) -> None:
    with sqlite3.connect(":memory:") as db:
        db.execute("PRAGMA foreign_keys = ON")
        for table in TABLES:
            schema = original.execute(
                "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", (table,)
            ).fetchone()
            db.execute(schema[0])
        db.executescript(sql.read_text(encoding="utf-8"))
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("Import violates a foreign key")
        for table, expected in counts.items():
            actual = db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
            if actual != expected:
                raise ValueError(f"Import count differs for {table}: {actual} vs {expected}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    default = make_url(Settings().database_url).database
    source = args.source or Path(default)
    args.directory.mkdir(parents=True, exist_ok=True)
    backup = args.directory / "bot-snapshot.db"
    sql = args.directory / "d1-import.sql"
    snapshot(source, backup)
    with sqlite3.connect(backup) as db:
        integrity = db.execute("PRAGMA integrity_check").fetchone()
        if integrity != ("ok",):
            raise RuntimeError("SQLite snapshot integrity check failed")
        counts = dump(db, sql)
        verify(db, sql, counts)
    print(json.dumps({"verified": True, "row_counts": counts}))
