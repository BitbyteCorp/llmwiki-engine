ALTER TABLE write_jobs ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX write_jobs_dedupe_key_active
  ON write_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status <> 'failed';
