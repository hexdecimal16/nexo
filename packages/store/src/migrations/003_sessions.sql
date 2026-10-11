-- Interactive sessions. A session's turns are root runs linked by session_id and turn_index; session_id has no
-- foreign key because reindex rebuilds both tables from their directories.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','closed')),
  budget_usd REAL NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dir_path TEXT NOT NULL
);
CREATE INDEX sessions_updated ON sessions(updated_at);

ALTER TABLE runs ADD COLUMN session_id TEXT;
ALTER TABLE runs ADD COLUMN turn_index INTEGER;
CREATE INDEX runs_session ON runs(session_id, turn_index);
