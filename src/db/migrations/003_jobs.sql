CREATE TABLE write_jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mcp', 'dreaming')),
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'merging', 'succeeded', 'failed')),
  summary TEXT,
  commits TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(commits) AND json_type(commits) = 'array'),
  merge_sha TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX write_jobs_queue ON write_jobs(status, created_at, id);
CREATE INDEX write_jobs_user_history ON write_jobs(user_id, created_at DESC, id DESC);
