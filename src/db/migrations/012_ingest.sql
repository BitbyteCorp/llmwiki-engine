CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('url','pdf','text','obsidian','notion','file')),
  source TEXT NOT NULL,
  sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('extracting','queued','running','succeeded','failed','cancelled')),
  raw_paths TEXT NOT NULL DEFAULT '[]',
  job_id TEXT REFERENCES write_jobs(id),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX imports_owner_created ON imports(user_id, created_at DESC, id DESC);
CREATE INDEX imports_job ON imports(job_id);
