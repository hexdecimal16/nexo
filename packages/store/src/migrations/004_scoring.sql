-- Scores of a run's scorers, one row per scorer per scoring round (round 0 is the first scoring, each S2 continuation
-- adds a round). run_id has no foreign key: reindex rebuilds the runs table and restores scores from run.json.
CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  scorer_kind TEXT NOT NULL CHECK (scorer_kind IN ('deterministic','judge','human')),
  scorer_type TEXT NOT NULL,
  scorer_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','failed')),
  value REAL,
  passed INTEGER,
  rationale TEXT NOT NULL DEFAULT '',
  criteria_json TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT,
  model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_unknown INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX scores_run ON scores(run_id, round);
