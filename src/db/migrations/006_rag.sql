CREATE TABLE index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  heading TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wiki', 'journal', 'raw', 'other')),
  ordinal INTEGER NOT NULL,
  vector_pending INTEGER NOT NULL DEFAULT 1 CHECK (vector_pending IN (0, 1)),
  UNIQUE(path, ordinal)
);
CREATE INDEX chunks_path ON chunks(path);
CREATE INDEX chunks_pending ON chunks(vector_pending);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title, heading, content,
  content='chunks', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, title, heading, content)
  VALUES (new.id, new.title, new.heading, new.content);
END;
CREATE TRIGGER chunks_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, heading, content)
  VALUES ('delete', old.id, old.title, old.heading, old.content);
END;
CREATE TRIGGER chunks_update AFTER UPDATE OF title, heading, content ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, heading, content)
  VALUES ('delete', old.id, old.title, old.heading, old.content);
  INSERT INTO chunks_fts(rowid, title, heading, content)
  VALUES (new.id, new.title, new.heading, new.content);
END;

CREATE TABLE embedding_cache (
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  PRIMARY KEY(content_hash, model, dimensions)
);

CREATE TABLE links (
  source_path TEXT NOT NULL,
  target_name TEXT NOT NULL,
  target_path TEXT,
  PRIMARY KEY(source_path, target_name)
);
CREATE INDEX links_target ON links(target_path);
