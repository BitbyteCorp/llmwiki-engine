CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX conversations_owner_updated ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations TEXT NOT NULL CHECK (json_valid(citations) AND json_type(citations) = 'array'),
  created_at TEXT NOT NULL,
  learned_at TEXT
);

CREATE INDEX messages_conversation_created ON messages(conversation_id, created_at);
