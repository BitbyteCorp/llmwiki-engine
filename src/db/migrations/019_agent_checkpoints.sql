CREATE TABLE agent_checkpoints (
  owner TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
