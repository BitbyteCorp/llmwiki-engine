CREATE TABLE write_jobs_history (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'luna' CHECK (kind IN ('luna', 'direct', 'revert')),
  source TEXT NOT NULL CHECK (source IN ('mcp', 'web', 'chat', 'dreaming', 'import', 'revert')),
  client TEXT,
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'merging', 'succeeded', 'failed')),
  summary TEXT,
  commits TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(commits) AND json_type(commits) = 'array'),
  conflicts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflicts) AND json_type(conflicts) = 'array'),
  merge_sha TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
INSERT INTO write_jobs_history (id, user_id, source, input, status, summary, commits, merge_sha, error, created_at, started_at, finished_at)
SELECT id, user_id, source, input, status, summary, commits, merge_sha, error, created_at, started_at, finished_at FROM write_jobs;
DROP TABLE write_jobs;
ALTER TABLE write_jobs_history RENAME TO write_jobs;
CREATE INDEX write_jobs_queue ON write_jobs(status, created_at, id);
CREATE INDEX write_jobs_user_history ON write_jobs(user_id, created_at DESC, id DESC);
CREATE TABLE write_job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES write_jobs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('queued', 'preparing', 'editing', 'committing', 'merging', 'resolving_conflict', 'indexing', 'cleanup', 'done', 'failed')),
  at TEXT NOT NULL,
  detail TEXT CHECK (detail IS NULL OR (json_valid(detail) AND json_type(detail) = 'object'))
);
CREATE INDEX write_job_events_job ON write_job_events(job_id, seq);
