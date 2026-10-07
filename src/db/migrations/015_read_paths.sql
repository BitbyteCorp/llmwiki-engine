-- Equality on conversation_id leaves the implicit rowid in insertion order.
CREATE INDEX messages_conversation_order ON messages(conversation_id);
-- Group latest generations per assistant, or seek a single assistant's latest rowid.
CREATE INDEX generations_assistant ON generations(conversation_id, assistant_message_id);
-- Catalog reads only each note's first chunk, without loading chunk bodies.
CREATE INDEX chunks_catalog ON chunks(ordinal, path, title, tags_json) WHERE ordinal = 0;
-- Global history pages cannot use the existing owner-prefixed indexes.
CREATE INDEX write_jobs_created ON write_jobs(created_at DESC, id DESC);
CREATE INDEX imports_created ON imports(created_at DESC, id DESC);
