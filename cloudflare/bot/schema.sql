CREATE TABLE IF NOT EXISTS users (
	id INTEGER NOT NULL, 
	telegram_id BIGINT NOT NULL, 
	language_code VARCHAR(10) NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	last_active_at DATETIME NOT NULL, 
	onboarding_completed BOOLEAN NOT NULL, 
	is_blocked BOOLEAN NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS media (
	id VARCHAR(32) NOT NULL, 
	source VARCHAR(20) NOT NULL, 
	external_id VARCHAR(100) NOT NULL, 
	media_type VARCHAR(5) NOT NULL, 
	metadata_json JSON NOT NULL, 
	metadata_updated_at DATETIME NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (source, external_id, media_type)
);

CREATE TABLE IF NOT EXISTS user_media_interactions (
	user_id INTEGER NOT NULL, 
	media_id VARCHAR(32) NOT NULL, 
	preference VARCHAR(8) NOT NULL, 
	is_watched BOOLEAN NOT NULL, 
	watched_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (user_id, media_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(media_id) REFERENCES media (id)
);

CREATE TABLE IF NOT EXISTS watchlist (
	user_id INTEGER NOT NULL, 
	media_id VARCHAR(32) NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (user_id, media_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(media_id) REFERENCES media (id)
);

CREATE TABLE IF NOT EXISTS user_preferences (
	user_id INTEGER NOT NULL, 
	genre_weights_json JSON NOT NULL, 
	preferred_media_types_json JSON NOT NULL, 
	preferred_languages_json JSON NOT NULL, 
	settings_json JSON NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (user_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recommendation_sessions (
	id VARCHAR(32) NOT NULL, 
	user_id INTEGER NOT NULL, 
	request_json JSON NOT NULL, 
	candidates JSON NOT NULL, 
	request_type VARCHAR(10) NOT NULL, 
	current_position INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	expires_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recommendations (
	id VARCHAR(32) NOT NULL, 
	user_id INTEGER NOT NULL, 
	media_id VARCHAR(32) NOT NULL, 
	session_id VARCHAR(32) NOT NULL, 
	request_type VARCHAR(10) NOT NULL, 
	recommendation_score FLOAT NOT NULL, 
	explanation VARCHAR NOT NULL, 
	recommended_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (session_id, media_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(media_id) REFERENCES media (id), 
	FOREIGN KEY(session_id) REFERENCES recommendation_sessions (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS analytics_events (
	id INTEGER NOT NULL, 
	user_id INTEGER, 
	event_name VARCHAR(50) NOT NULL, 
	metadata_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_analytics_events_created_at ON analytics_events (created_at);

CREATE INDEX IF NOT EXISTS ix_analytics_events_user_id ON analytics_events (user_id);

CREATE INDEX IF NOT EXISTS ix_analytics_name_date ON analytics_events (event_name, created_at);

CREATE INDEX IF NOT EXISTS ix_recommendation_sessions_user_id ON recommendation_sessions (user_id);

CREATE INDEX IF NOT EXISTS ix_recommendations_user_date ON recommendations (user_id, recommended_at);

CREATE UNIQUE INDEX IF NOT EXISTS ix_users_telegram_id ON users (telegram_id);

CREATE INDEX IF NOT EXISTS ix_watchlist_user_created ON watchlist (user_id, created_at);

CREATE TABLE IF NOT EXISTS worker_state (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, version INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS worker_catalog (key TEXT PRIMARY KEY, document TEXT NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS worker_updates (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT (unixepoch()));

CREATE INDEX IF NOT EXISTS worker_updates_created ON worker_updates(created_at);
