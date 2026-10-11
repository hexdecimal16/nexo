-- Eval cases (spec §5.2). Phase 3 adds one per run whose judge verdict disagrees with the human verdict, with target
-- 'judge_rubric'; the optimizer reads the same table later. source_run_id has no foreign key, like feedback.run_id.
CREATE TABLE eval_cases (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  source_run_id TEXT,
  input TEXT NOT NULL,
  expected TEXT,
  reference_feedback TEXT,
  scorer_spec_json TEXT,
  split TEXT NOT NULL CHECK (split IN ('feedback','pareto','holdout')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX eval_cases_source ON eval_cases(target, source_run_id);

-- Results of `nexo eval judge`: judge verdicts compared with human verdicts.
CREATE TABLE judge_calibrations (
  id TEXT PRIMARY KEY,
  judge_key TEXT NOT NULL,
  cases INTEGER NOT NULL,
  agreements INTEGER NOT NULL,
  accuracy REAL,
  kappa REAL,
  matrix_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX judge_calibrations_created ON judge_calibrations(created_at);
