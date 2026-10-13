CREATE TABLE mcp_login_requests (
  id_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  flow TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX mcp_login_requests_expires ON mcp_login_requests(expires_at);
