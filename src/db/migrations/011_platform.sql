CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_events_actor ON audit_events(actor_id, id DESC);
CREATE INDEX audit_events_action ON audit_events(action, id DESC);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
CREATE INDEX api_tokens_expiry ON api_tokens(expires_at);
CREATE INDEX api_tokens_revoked ON api_tokens(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX web_sessions_expiry ON web_sessions(expires_at);
CREATE INDEX auth_pending_expiry ON auth_pending(expires_at);
CREATE INDEX oauth_clients_expiry ON oauth_clients(expires_at);
CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);
CREATE INDEX oauth_access_expiry ON oauth_access_tokens(expires_at);
CREATE INDEX oauth_refresh_expiry ON oauth_refresh_tokens(expires_at);
CREATE INDEX oauth_access_revoked ON oauth_access_tokens(revoked) WHERE revoked = 1;
CREATE INDEX oauth_refresh_revoked ON oauth_refresh_tokens(revoked) WHERE revoked = 1;
