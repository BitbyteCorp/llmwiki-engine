-- UUID columns use unpadded base64url; opaque replay documents use API base62.
-- Keep FK enforcement enabled while parents and references change together.
PRAGMA defer_foreign_keys = ON;

UPDATE write_jobs SET id = legacy_uuid_to_storage(id)
WHERE id IS NOT legacy_uuid_to_storage(id);
-- Chat client and dedupe strings are composed from application-form identifiers.
UPDATE write_jobs SET client = legacy_uuids_to_api(client)
WHERE source = 'chat' AND length(client) = 36
  AND client IS NOT legacy_uuids_to_api(client);
WITH candidates AS (
  SELECT rowid, substr(dedupe_key, 80) AS suffix FROM write_jobs
  WHERE source = 'chat'
    AND dedupe_key GLOB 'chat:????????-????-????-????-????????????:????????-????-????-????-????????????:*:*:*'
    AND length(dedupe_key) - length(replace(dedupe_key, ':', '')) = 5
), ordinal_parts AS (
  SELECT rowid,
    substr(suffix, 1, instr(suffix, ':') - 1) AS ordinal,
    substr(suffix, instr(suffix, ':') + 1) AS remainder
  FROM candidates
), parts AS (
  SELECT rowid, ordinal,
    substr(remainder, 1, instr(remainder, ':') - 1) AS revision,
    substr(remainder, instr(remainder, ':') + 1) AS requester
  FROM ordinal_parts
)
UPDATE write_jobs SET dedupe_key = legacy_uuids_to_api(dedupe_key)
WHERE rowid IN (
  SELECT rowid FROM parts
  WHERE ordinal <> '' AND ordinal NOT GLOB '*[^0-9]*'
    AND length(revision) = 64 AND revision NOT GLOB '*[^0-9a-f]*'
    AND requester <> '' AND requester NOT GLOB '*[^0-9]*'
)
  AND dedupe_key IS NOT legacy_uuids_to_api(dedupe_key);

UPDATE write_job_events
SET job_id = legacy_uuid_to_storage(job_id),
    detail = legacy_json_ids_to_api(detail)
WHERE job_id IS NOT legacy_uuid_to_storage(job_id)
   OR detail IS NOT legacy_json_ids_to_api(detail);

UPDATE conversations
SET id = legacy_uuid_to_storage(id),
    summary_through = legacy_uuid_to_storage(summary_through)
WHERE id IS NOT legacy_uuid_to_storage(id)
   OR summary_through IS NOT legacy_uuid_to_storage(summary_through);
UPDATE messages
SET id = legacy_uuid_to_storage(id),
    conversation_id = legacy_uuid_to_storage(conversation_id),
    attachments = (
      SELECT json_group_array(legacy_uuid_to_storage(value))
      FROM json_each(messages.attachments)
    )
WHERE id IS NOT legacy_uuid_to_storage(id)
   OR conversation_id IS NOT legacy_uuid_to_storage(conversation_id)
   OR EXISTS (
     SELECT 1 FROM json_each(messages.attachments)
     WHERE value IS NOT legacy_uuid_to_storage(value)
   );
UPDATE conversation_members
SET conversation_id = legacy_uuid_to_storage(conversation_id)
WHERE conversation_id IS NOT legacy_uuid_to_storage(conversation_id);

UPDATE uploads SET id = legacy_uuid_to_storage(id)
WHERE id IS NOT legacy_uuid_to_storage(id);
UPDATE generations
SET id = legacy_uuid_to_storage(id),
    conversation_id = legacy_uuid_to_storage(conversation_id),
    user_message_id = legacy_uuid_to_storage(user_message_id),
    assistant_message_id = legacy_uuid_to_storage(assistant_message_id)
WHERE id IS NOT legacy_uuid_to_storage(id)
   OR conversation_id IS NOT legacy_uuid_to_storage(conversation_id)
   OR user_message_id IS NOT legacy_uuid_to_storage(user_message_id)
   OR assistant_message_id IS NOT legacy_uuid_to_storage(assistant_message_id);
UPDATE generation_frames
SET generation_id = legacy_uuid_to_storage(generation_id),
    data = legacy_json_ids_to_api(data)
WHERE generation_id IS NOT legacy_uuid_to_storage(generation_id)
   OR data IS NOT legacy_json_ids_to_api(data);

UPDATE api_tokens SET id = legacy_uuid_to_storage(id)
WHERE id IS NOT legacy_uuid_to_storage(id);
UPDATE dream_runs SET id = legacy_uuid_to_storage(id)
WHERE id IS NOT legacy_uuid_to_storage(id);
UPDATE imports
SET id = legacy_uuid_to_storage(id),
    job_id = legacy_uuid_to_storage(job_id)
WHERE id IS NOT legacy_uuid_to_storage(id)
   OR job_id IS NOT legacy_uuid_to_storage(job_id);
UPDATE imports SET source = legacy_uuids_to_api(source)
WHERE substr(source, 1, 7) = 'upload:' AND length(source) = 43
  AND source IS NOT legacy_uuids_to_api(source);

-- Audit targets may be composite emitted strings rather than relational keys.
-- Names, summaries, user content, client ids, secrets, SHAs and note paths stay intact.
UPDATE audit_events SET target = legacy_uuids_to_api(target)
WHERE target IS NOT legacy_uuids_to_api(target);
