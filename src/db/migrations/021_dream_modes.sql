ALTER TABLE dream_runs ADD COLUMN mode TEXT
  CHECK (mode IN ('local', 'structural', 'sweep'));
ALTER TABLE dream_runs ADD COLUMN focus TEXT;
ALTER TABLE dream_runs ADD COLUMN structural_changes TEXT NOT NULL DEFAULT '[]';
