CREATE TABLE llm_usage (
  at TEXT NOT NULL,
  lane TEXT NOT NULL,
  model TEXT NOT NULL,
  owner TEXT,
  ref TEXT,
  input INTEGER NOT NULL,
  cached_input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL,
  reasoning INTEGER NOT NULL
);

CREATE INDEX llm_usage_at ON llm_usage(at);
