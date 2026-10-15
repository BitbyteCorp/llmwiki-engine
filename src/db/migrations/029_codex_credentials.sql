CREATE TABLE codex_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  id_token TEXT,
  account_id TEXT NOT NULL,
  email TEXT,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
