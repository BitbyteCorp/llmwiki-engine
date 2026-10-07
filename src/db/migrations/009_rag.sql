ALTER TABLE chunks ADD COLUMN tags TEXT NOT NULL DEFAULT '';
ALTER TABLE chunks ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE chunks ADD COLUMN anchor TEXT;
ALTER TABLE chunks ADD COLUMN source_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN source_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN updated_at TEXT;
ALTER TABLE chunks ADD COLUMN author TEXT;
ALTER TABLE chunks ADD COLUMN normalized_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX chunks_updated_at ON chunks(updated_at);
CREATE INDEX chunks_author ON chunks(author);
CREATE INDEX chunks_normalized_hash ON chunks(normalized_hash);

DROP TRIGGER chunks_insert;
DROP TRIGGER chunks_delete;
DROP TRIGGER chunks_update;
DROP TABLE chunks_fts;
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title, heading, tags, content,
  content='chunks', content_rowid='id', tokenize='trigram'
);
CREATE VIRTUAL TABLE chunks_terms USING fts5(
  title, heading, tags, content,
  content='chunks', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid,title,heading,tags,content) VALUES (new.id,new.title,new.heading,new.tags,new.content);
  INSERT INTO chunks_terms(rowid,title,heading,tags,content) VALUES (new.id,new.title,new.heading,new.tags,new.content);
END;
CREATE TRIGGER chunks_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts,rowid,title,heading,tags,content) VALUES ('delete',old.id,old.title,old.heading,old.tags,old.content);
  INSERT INTO chunks_terms(chunks_terms,rowid,title,heading,tags,content) VALUES ('delete',old.id,old.title,old.heading,old.tags,old.content);
END;
CREATE TRIGGER chunks_update AFTER UPDATE OF title,heading,tags,content ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts,rowid,title,heading,tags,content) VALUES ('delete',old.id,old.title,old.heading,old.tags,old.content);
  INSERT INTO chunks_terms(chunks_terms,rowid,title,heading,tags,content) VALUES ('delete',old.id,old.title,old.heading,old.tags,old.content);
  INSERT INTO chunks_fts(rowid,title,heading,tags,content) VALUES (new.id,new.title,new.heading,new.tags,new.content);
  INSERT INTO chunks_terms(rowid,title,heading,tags,content) VALUES (new.id,new.title,new.heading,new.tags,new.content);
END;
INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
INSERT INTO chunks_terms(chunks_terms) VALUES ('rebuild');
-- Old chunks have no offsets, tags, or note hashes. The next synchronization
-- must regenerate every note, even when the repository HEAD has not changed.
DELETE FROM index_meta WHERE key = 'layout_version';
