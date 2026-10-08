-- rebuild-table: imports
-- drop-schema: imports_job
CREATE TABLE import_jobs (
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  batch INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  files TEXT NOT NULL,
  PRIMARY KEY (import_id, batch)
);
CREATE INDEX import_jobs_job ON import_jobs(job_id);
INSERT INTO import_jobs (import_id, batch, job_id, files)
SELECT id, 0, job_id, '[]' FROM imports WHERE job_id IS NOT NULL;

CREATE TABLE imports_batched (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('url','pdf','text','obsidian','notion','file')),
  source TEXT NOT NULL,
  sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('extracting','queued','running','succeeded','failed','cancelled')),
  raw_paths TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
INSERT INTO imports_batched (
  rowid, id, user_id, kind, source, sha, status, raw_paths, error,
  created_at, updated_at, finished_at
)
SELECT
  rowid, id, user_id, kind, source, sha, status, raw_paths, error,
  created_at, updated_at, finished_at
FROM imports;
DROP TABLE imports;
ALTER TABLE imports_batched RENAME TO imports;
