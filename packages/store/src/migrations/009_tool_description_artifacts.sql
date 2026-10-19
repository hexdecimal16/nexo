-- nexo:foreign-keys-off
-- Tool descriptions become an optimization target (artifact kind 'tool_description', name = the tool's name).
-- artifacts is rebuilt because SQLite cannot widen a CHECK in place. optim_runs and optim_candidates reference it,
-- so the runner switches foreign keys off for this file and runs foreign_key_check before it commits.
CREATE TABLE artifacts_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('system_prompt','skill','playbook','router_policy','judge_rubric','planner_prompt','tool_description')),
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
INSERT INTO artifacts_new (id, kind, name, version, content, content_hash, parent_version_id, origin, status, created_at)
SELECT id, kind, name, version, content, content_hash, parent_version_id, origin, status, created_at FROM artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;
CREATE UNIQUE INDEX artifacts_one_active ON artifacts(kind, name) WHERE status = 'active';
