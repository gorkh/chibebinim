CREATE TABLE IF NOT EXISTS pilot_sessions (
  id TEXT PRIMARY KEY,
  step INTEGER NOT NULL CHECK (step BETWEEN 0 AND 2)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pilot_watchlist (
  session_id TEXT PRIMARY KEY REFERENCES pilot_sessions(id),
  title TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pilot_live_cache (
  id TEXT PRIMARY KEY,
  titles TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pilot_live_sessions (
  id TEXT PRIMARY KEY,
  cache_id TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 2),
  titles TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pilot_live_history (
  session_id TEXT NOT NULL REFERENCES pilot_live_sessions(id),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 1),
  media_id TEXT NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (session_id, position)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pilot_live_watchlist (
  session_id TEXT PRIMARY KEY REFERENCES pilot_live_sessions(id),
  media_id TEXT NOT NULL,
  title TEXT NOT NULL
) WITHOUT ROWID;
