ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN summary_through TEXT;
ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments));
ALTER TABLE messages ADD COLUMN context TEXT;
ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE messages ADD COLUMN usage TEXT;
ALTER TABLE messages ADD COLUMN model TEXT;
ALTER TABLE messages ADD COLUMN effort TEXT;

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
  PRIMARY KEY(conversation_id,user_id)
);
INSERT INTO conversation_members SELECT id,user_id,'owner' FROM conversations;
CREATE INDEX conversation_members_user ON conversation_members(user_id,conversation_id);
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'chat' CHECK(purpose IN ('chat','import')),
  saved_at TEXT
);
CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT,
  status TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX generations_client ON generations(conversation_id,client_id) WHERE client_id IS NOT NULL;
CREATE INDEX generations_conversation ON generations(conversation_id,created_at);
CREATE TABLE generation_frames (
  generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(generation_id,seq)
);
