ALTER TABLE dream_runs ADD COLUMN summary TEXT;
ALTER TABLE dream_runs ADD COLUMN changed_paths TEXT NOT NULL DEFAULT '[]';
ALTER TABLE dream_runs ADD COLUMN journal_path TEXT;
ALTER TABLE dream_runs ADD COLUMN push_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (push_status IN ('pending', 'succeeded', 'skipped', 'failed'));
ALTER TABLE dream_runs ADD COLUMN push_remote TEXT;
ALTER TABLE dream_runs ADD COLUMN push_sha TEXT;
ALTER TABLE dream_runs ADD COLUMN push_at TEXT;
ALTER TABLE dream_runs ADD COLUMN push_reason TEXT;

-- Older runs only recorded a boolean, so do not invent a remote or SHA.
UPDATE dream_runs SET push_status = 'succeeded', push_at = finished_at WHERE pushed = 1;
UPDATE dream_runs SET push_status = 'skipped', push_at = finished_at,
  push_reason = 'Legacy run did not record a push result'
  WHERE pushed = 0 AND finished_at IS NOT NULL;

CREATE INDEX dream_runs_started ON dream_runs(started_at DESC, id DESC);
CREATE INDEX dream_runs_backup_success ON dream_runs(push_at DESC) WHERE push_status = 'succeeded';
