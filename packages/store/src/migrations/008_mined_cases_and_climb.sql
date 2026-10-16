-- Mined eval cases and climb (2026-10-16 design §2). eval_cases is rebuilt because SQLite cannot widen a CHECK in place:
-- origin gains 'mined', and every case gains a status (only 'active' cases enter optimizations), the source of its
-- golden (`expected`) and, for a mined case, the run ids of its cluster.
CREATE TABLE eval_cases_new (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  source_run_id TEXT,
  input TEXT NOT NULL,
  expected TEXT,
  reference_feedback TEXT,
  scorer_spec_json TEXT,
  split TEXT NOT NULL CHECK (split IN ('feedback','pareto','holdout')),
  created_at TEXT NOT NULL,
  skill TEXT,
  origin TEXT NOT NULL DEFAULT 'run' CHECK (origin IN ('run','manual','mined')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','dismissed')),
  golden_source TEXT CHECK (golden_source IN ('run','manual','climb')),
  mined_from_json TEXT
);
INSERT INTO eval_cases_new (id, target, source_run_id, input, expected, reference_feedback, scorer_spec_json, split, created_at, skill, origin, status, golden_source)
SELECT id, target, source_run_id, input, expected, reference_feedback, scorer_spec_json, split, created_at, skill, origin, 'active',
  CASE WHEN expected IS NULL OR target = 'judge_rubric' THEN NULL WHEN origin = 'manual' THEN 'manual' ELSE 'run' END
FROM eval_cases;
DROP TABLE eval_cases;
ALTER TABLE eval_cases_new RENAME TO eval_cases;
CREATE UNIQUE INDEX eval_cases_source ON eval_cases(target, source_run_id);
CREATE INDEX eval_cases_target_status ON eval_cases(target, status);

-- Every value a case's golden has held, so a climb raise can be audited and reverted.
CREATE TABLE eval_case_goldens (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  expected TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('run','manual','climb')),
  source_run_id TEXT,
  optim_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX eval_case_goldens_case ON eval_case_goldens(case_id, created_at);
INSERT INTO eval_case_goldens (id, case_id, expected, source, source_run_id, optim_run_id, created_at)
SELECT 'g' || id, id, expected, golden_source, source_run_id, NULL, created_at FROM eval_cases WHERE golden_source IS NOT NULL;

-- Climb runs share optim_runs with GEPA runs.
ALTER TABLE optim_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'gepa' CHECK (mode IN ('gepa','climb'));
ALTER TABLE optim_runs ADD COLUMN case_id TEXT;
ALTER TABLE optim_runs ADD COLUMN climb_outcome TEXT CHECK (climb_outcome IN ('improved','golden_raised','no_signal','not_improved','guard_regressed'));
