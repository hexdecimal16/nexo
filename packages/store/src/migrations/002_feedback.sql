-- run_id has no foreign key: reindex deletes and rebuilds the runs table, and human feedback must survive that.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('done','not_done')),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX feedback_run ON feedback(run_id, created_at);
