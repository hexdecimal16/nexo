-- nexo:foreign-keys-off
-- Project-scoped memories (scope 'project:<hash>', from projectScope) were accepted by the store but rejected by the
-- CHECK from 006, so every curator delta holding one failed as a whole. SQLite cannot widen a CHECK in place, so the
-- table is rebuilt. Rowids are copied explicitly because memories_fts is keyed by the memories rowid.
-- memory_embeddings references memories(id), so the runner switches foreign keys off and runs foreign_key_check.
CREATE TABLE memories_new (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'global') OR (scope GLOB 'skill:?*') OR (scope GLOB 'project:?*')),
  type TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'lesson', 'workflow')),
  content TEXT NOT NULL,
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  source TEXT NOT NULL CHECK (source IN ('ace', 'human', 'user')),
  source_run_id TEXT,
  superseded_by TEXT REFERENCES memories(id),
  retired_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
INSERT INTO memories_new (rowid, id, scope, type, content, importance, source, source_run_id, superseded_by, retired_at, created_at, last_used_at)
SELECT rowid, id, scope, type, content, importance, source, source_run_id, superseded_by, retired_at, created_at, last_used_at FROM memories;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;
CREATE INDEX memories_live ON memories(scope) WHERE superseded_by IS NULL AND retired_at IS NULL;
CREATE INDEX memories_source_run ON memories(source_run_id);
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, content) VALUES (new.rowid, new.content);
END;
