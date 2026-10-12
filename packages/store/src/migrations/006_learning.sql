-- Learning state (spec §5.2, §8): memories with FTS and embeddings, playbook items with their history, learn jobs.
-- run ids have no foreign key, like scores and feedback: reindex rebuilds the runs table and keeps these rows.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'global') OR (scope GLOB 'skill:?*')),
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
CREATE INDEX memories_live ON memories(scope) WHERE superseded_by IS NULL AND retired_at IS NULL;
CREATE INDEX memories_source_run ON memories(source_run_id);

-- Full-text index over memories.content; its rowid is the memories rowid. Content never changes after insert
-- (a replacement is a new row), so only inserts are mirrored.
CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize = 'porter unicode61');
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, content) VALUES (new.rowid, new.content);
END;

-- One embedding per memory: float32 little-endian, `dim` values, from `model` (`provider/id`).
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id),
  model TEXT NOT NULL,
  dim INTEGER NOT NULL CHECK (dim > 0),
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE playbook_items (
  id TEXT PRIMARY KEY,
  artifact_name TEXT NOT NULL,
  item_key TEXT NOT NULL,
  content TEXT NOT NULL,
  helpful INTEGER NOT NULL DEFAULT 0 CHECK (helpful >= 0),
  harmful INTEGER NOT NULL DEFAULT 0 CHECK (harmful >= 0),
  source TEXT NOT NULL CHECK (source IN ('ace', 'human')),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (artifact_name, item_key)
);

CREATE TABLE playbook_item_history (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES playbook_items(id),
  action TEXT NOT NULL CHECK (action IN ('add', 'update', 'retire', 'helpful', 'harmful', 'prune')),
  content TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('ace', 'human', 'user')),
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX playbook_item_history_item ON playbook_item_history(item_id, created_at);

CREATE TABLE learn_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reflect', 'curate', 'score')),
  trigger TEXT NOT NULL CHECK (trigger IN ('run_end', 'feedback')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- At most one pending job per run and kind: a verdict that arrives while the run's job is still pending is picked
-- up by that job, which reads the latest verdict when it runs.
CREATE UNIQUE INDEX learn_jobs_one_pending ON learn_jobs(run_id, kind) WHERE status = 'pending';
CREATE INDEX learn_jobs_status ON learn_jobs(status, created_at);
