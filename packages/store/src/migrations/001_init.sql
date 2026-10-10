CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  parent_run_id TEXT REFERENCES runs(id),
  root_run_id TEXT NOT NULL,
  dir_path TEXT NOT NULL,
  instruction TEXT NOT NULL,
  skill TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','aborted','budget_exceeded')),
  config_snapshot_hash TEXT NOT NULL,
  artifact_set_id TEXT,
  model_final TEXT,
  tier_final TEXT,
  escalations INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_unknown INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  error_json TEXT
);
CREATE INDEX runs_root ON runs(root_run_id);
CREATE INDEX runs_parent ON runs(parent_run_id);
CREATE INDEX runs_started ON runs(started_at);
CREATE INDEX runs_status ON runs(status);

CREATE TABLE spans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_span_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  queued_ms INTEGER,
  model TEXT,
  provider TEXT,
  tier TEXT,
  effort TEXT,
  model_source TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_unknown INTEGER NOT NULL DEFAULT 0,
  payload_ref TEXT,
  attrs_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX spans_run ON spans(run_id);
CREATE INDEX spans_kind_started ON spans(kind, started_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('system_prompt','skill','playbook','router_policy','judge_rubric','planner_prompt')),
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parent_version_id TEXT REFERENCES artifacts(id),
  origin TEXT NOT NULL CHECK (origin IN ('manual','ace','gepa')),
  status TEXT NOT NULL CHECK (status IN ('active','candidate','retired')),
  created_at TEXT NOT NULL,
  UNIQUE (kind, name, version)
);

CREATE TABLE artifact_sets (
  id TEXT PRIMARY KEY,
  members_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE budget_ledger (
  scope TEXT PRIMARY KEY,
  reserved_usd REAL NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
