-- GEPA optimization (spec §5.2, §8.2). A rollout is a root run with optim_run_id set; so is the optimizer's own run row
-- (its id is the optimization id), which holds the reflection and judge-rubric evaluation spans. Run lists and the
-- review queue leave these runs out. optim_runs and optim_candidates are kept by reindex, like scores and feedback.
ALTER TABLE runs ADD COLUMN optim_run_id TEXT;
CREATE INDEX runs_optim ON runs(optim_run_id);

-- Eval cases gain the skill the source run used (rollouts run with it) and where the case came from.
ALTER TABLE eval_cases ADD COLUMN skill TEXT;
ALTER TABLE eval_cases ADD COLUMN origin TEXT NOT NULL DEFAULT 'run' CHECK (origin IN ('run', 'manual'));

CREATE TABLE optim_runs (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
  stop_reason TEXT,
  budget_usd REAL NOT NULL CHECK (budget_usd > 0),
  budget_rollouts INTEGER,
  spent_usd REAL NOT NULL DEFAULT 0,
  rollouts INTEGER NOT NULL DEFAULT 0,
  merge INTEGER NOT NULL DEFAULT 0,
  seed INTEGER NOT NULL,
  base_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  best_artifact_id TEXT REFERENCES artifacts(id),
  dir_path TEXT NOT NULL,
  report_ref TEXT,
  judge_key TEXT,
  judge_only INTEGER,
  holdout_before REAL,
  holdout_after REAL,
  promotion TEXT CHECK (promotion IN ('approved', 'rolled_back')),
  replaced_artifact_id TEXT REFERENCES artifacts(id),
  promoted_at TEXT,
  pid INTEGER,
  error_json TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX optim_runs_created ON optim_runs(created_at);

CREATE TABLE optim_candidates (
  id TEXT PRIMARY KEY,
  optim_run_id TEXT NOT NULL REFERENCES optim_runs(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  parent_ids_json TEXT NOT NULL DEFAULT '[]',
  iteration INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('seed', 'reflect', 'merge')),
  component TEXT,
  minibatch_json TEXT,
  per_case_json TEXT NOT NULL DEFAULT '{}',
  mean_score REAL,
  mean_cost_usd REAL,
  accepted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX optim_candidates_run ON optim_candidates(optim_run_id, created_at);
