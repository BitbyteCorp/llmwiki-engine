ALTER TABLE chunks ADD COLUMN note_type TEXT;
ALTER TABLE chunks ADD COLUMN description TEXT;
ALTER TABLE chunks ADD COLUMN aliases TEXT;
ALTER TABLE chunks ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX chunks_note_type ON chunks(note_type);

DROP TRIGGER chunks_insert;
DROP TRIGGER chunks_delete;
DROP TRIGGER chunks_update;
DROP TABLE chunks_fts;
DROP TABLE chunks_terms;
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title, heading, tags, content, description, aliases,
  content='chunks', content_rowid='id', tokenize='trigram'
);
CREATE VIRTUAL TABLE chunks_terms USING fts5(
  title, heading, tags, content, description, aliases,
  content='chunks', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid,title,heading,tags,content,description,aliases)
  VALUES (new.id,new.title,new.heading,new.tags,new.content,new.description,new.aliases);
  INSERT INTO chunks_terms(rowid,title,heading,tags,content,description,aliases)
  VALUES (new.id,new.title,new.heading,new.tags,new.content,new.description,new.aliases);
END;
CREATE TRIGGER chunks_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts,rowid,title,heading,tags,content,description,aliases)
  VALUES ('delete',old.id,old.title,old.heading,old.tags,old.content,old.description,old.aliases);
  INSERT INTO chunks_terms(chunks_terms,rowid,title,heading,tags,content,description,aliases)
  VALUES ('delete',old.id,old.title,old.heading,old.tags,old.content,old.description,old.aliases);
END;
CREATE TRIGGER chunks_update AFTER UPDATE OF title,heading,tags,content,description,aliases ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts,rowid,title,heading,tags,content,description,aliases)
  VALUES ('delete',old.id,old.title,old.heading,old.tags,old.content,old.description,old.aliases);
  INSERT INTO chunks_terms(chunks_terms,rowid,title,heading,tags,content,description,aliases)
  VALUES ('delete',old.id,old.title,old.heading,old.tags,old.content,old.description,old.aliases);
  INSERT INTO chunks_fts(rowid,title,heading,tags,content,description,aliases)
  VALUES (new.id,new.title,new.heading,new.tags,new.content,new.description,new.aliases);
  INSERT INTO chunks_terms(rowid,title,heading,tags,content,description,aliases)
  VALUES (new.id,new.title,new.heading,new.tags,new.content,new.description,new.aliases);
END;
INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
INSERT INTO chunks_terms(chunks_terms) VALUES ('rebuild');
-- Metadata and embedding inputs must be derived from the original markdown,
-- even when the repository HEAD is unchanged after the schema upgrade.
DELETE FROM index_meta WHERE key = 'layout_version';
