ALTER TABLE links ADD COLUMN target_text TEXT NOT NULL DEFAULT '';

-- Normalized keys cannot recover original spelling or folder-qualified targets.
-- Reparse raw notes even when the repository HEAD has not changed.
DELETE FROM index_meta WHERE key = 'layout_version';
