-- rebuild-table: write_jobs
-- The runner rebuilds this table with foreign keys disabled outside the transaction
-- and restores its indexes and triggers before validating all foreign keys.
CREATE TABLE write_jobs_agent (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'direct', 'revert')),
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
INSERT INTO write_jobs_agent (
  rowid, id, user_id, kind, source, client, input, status, summary, commits,
  conflicts, merge_sha, error, created_at, started_at, finished_at
)
SELECT
  rowid, id, user_id,
  CASE kind WHEN 'luna' THEN 'agent' ELSE kind END,
  source, client, input, status, summary, commits,
  conflicts, merge_sha, error, created_at, started_at, finished_at
FROM write_jobs;
DROP TABLE write_jobs;
ALTER TABLE write_jobs_agent RENAME TO write_jobs;
