CREATE TABLE dream_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  from_sha TEXT,
  to_sha TEXT,
  merge_sha TEXT,
  pushed INTEGER NOT NULL DEFAULT 0 CHECK (pushed IN (0, 1)),
  error TEXT
);

CREATE INDEX dream_runs_success ON dream_runs(finished_at DESC)
  WHERE status = 'succeeded';
