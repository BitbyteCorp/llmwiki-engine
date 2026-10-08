ALTER TABLE imports ADD COLUMN retained_text TEXT;
ALTER TABLE imports ADD COLUMN filename TEXT;
ALTER TABLE imports ADD COLUMN instructions TEXT;
ALTER TABLE imports ADD COLUMN raw_committed INTEGER NOT NULL DEFAULT 0;

UPDATE imports SET raw_committed = 1
WHERE EXISTS (SELECT 1 FROM import_jobs WHERE import_id = imports.id);
