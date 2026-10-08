import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fromStorageId, legacyUuidToApi, legacyUuidToStorage } from '../src/common/ids.js';
import { openDb, runMigrations, type Db } from '../src/db/index.js';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const identifierMigrationSql = readFileSync(join(migrationsDirectory, '018_base62_ids.sql'), 'utf8');
const at = '2026-01-01T00:00:00.000Z';
const ids = {
  job: '01234567-89ab-4cde-8f01-23456789abcd',
  conversation: '12345678-9abc-4def-9012-3456789abcde',
  emptyConversation: '23456789-abcd-4ef0-a123-456789abcdef',
  userMessage: '3456789a-bcde-4f01-b234-56789abcdef0',
  assistantMessage: '456789ab-cdef-4012-8345-6789abcdef01',
  upload: '56789abc-def0-4123-9456-789abcdef012',
  secondUpload: '6789abcd-ef01-4234-a567-89abcdef0123',
  storedAttachment: '789abcde-f012-4345-b678-9abcdef01234',
  generation: '89abcdef-0123-4456-8789-abcdef012345',
  nullableGeneration: '9abcdef0-1234-4567-989a-bcdef0123456',
  apiToken: 'abcdef01-2345-4678-a9ab-cdef01234567',
  dream: 'bcdef012-3456-4789-babc-def012345678',
  import: 'cdef0123-4567-489a-8bcd-ef0123456789',
  nullableImport: 'def01234-5678-49ab-9cde-f0123456789a',
  nonChatJob: '01234567-89ab-4cde-8f01-23456789abce',
  opaqueChatJob: '01234567-89ab-4cde-8f01-23456789abcf',
  opaqueImport: '01234567-89ab-4cde-8f01-23456789abc0',
};
const opaqueUuid = 'ef012345-6789-4abc-adef-0123456789ab';
const notePath = `notes/${opaqueUuid}.md`;
const userText = `Keep ${opaqueUuid} as written by the user.`;
const revision = 'f'.repeat(64);
const chatDedupeKey = `chat:${ids.conversation}:${ids.userMessage}:1:${revision}:1`;
const opaqueDedupeKey = `external:${opaqueUuid}`;
const malformedChatDedupeKey = `chat:${ids.conversation}:${ids.userMessage}:not-an-ordinal:${revision}:1`;
const citations = JSON.stringify([{ path: notePath, title: opaqueUuid }]);
const context = JSON.stringify({ notes: [{ path: notePath }], selectedText: userText });
const replayDetail = {
  jobId: ids.job,
  nested: {
    conversationId: ids.conversation,
    messages: [ids.userMessage, { id: ids.assistantMessage }],
    uploadIds: [ids.upload, ids.secondUpload],
    alreadyApi: legacyUuidToApi(ids.generation),
    untouched: ['initialize', 'note.md', 'not-an-id', userText, notePath, null, 7, false],
  },
};
const replayFrame = {
  generationId: ids.generation,
  message: { id: ids.assistantMessage, conversationId: ids.conversation },
  nested: [{ uploadId: ids.upload }, [ids.userMessage, { jobId: ids.job }]],
  alreadyApi: legacyUuidToApi(ids.apiToken),
  untouched: {
    path: notePath,
    clientId: 'desktop-client',
    text: userText,
    delta: `delta ${ids.userMessage}`,
    [opaqueUuid]: 'UUID object keys are not identifier values',
    value: null,
  },
};

function migrateHistoricalDb(db: Db): void {
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const name of readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql') && name < '018_').sort()) {
    const sql = readFileSync(join(migrationsDirectory, name), 'utf8');
    const rebuiltTable = sql.match(/^-- rebuild-table: ([a-z_][a-z0-9_]*)$/m)?.[1];
    const foreignKeys = rebuiltTable ? db.pragma('foreign_keys', { simple: true }) : undefined;
    const preservedSchema = rebuiltTable
      ? db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL").all(rebuiltTable) as Array<{ sql: string }>
      : [];
    if (rebuiltTable) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        for (const entry of preservedSchema) db.exec(entry.sql);
        if (rebuiltTable && (db.pragma('foreign_key_check') as unknown[]).length > 0) {
          throw new Error(`Foreign key violations after historical migration ${name}`);
        }
        record.run(name, at);
      })();
    } finally {
      if (rebuiltTable) db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }
  }
}

function seedHistoricalDb(db: Db): void {
  db.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (1, ?, ?, ?, ?)')
    .run('writer@example.com', opaqueUuid, 'editor', at);
  db.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (2, ?, ?, ?, ?)')
    .run('reader@example.com', userText, 'viewer', at);
  db.prepare(`INSERT INTO write_jobs
    (id, user_id, source, client, input, status, summary, commits, conflicts, merge_sha, created_at, dedupe_key)
    VALUES (?, 1, 'chat', ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?)`)
    .run(ids.job, ids.conversation, userText, opaqueUuid, JSON.stringify([opaqueUuid]), JSON.stringify([notePath]), opaqueUuid, at, chatDedupeKey);
  const insertControlJob = db.prepare(`INSERT INTO write_jobs
    (id, user_id, source, client, input, status, created_at, dedupe_key)
    VALUES (?, 1, ?, ?, ?, 'succeeded', ?, ?)`);
  insertControlJob.run(ids.nonChatJob, 'mcp', opaqueUuid, userText, at, opaqueDedupeKey);
  insertControlJob.run(ids.opaqueChatJob, 'chat', `conversation:${opaqueUuid}`, userText, at, malformedChatDedupeKey);
  const insertEvent = db.prepare('INSERT INTO write_job_events (job_id, phase, at, detail) VALUES (?, ?, ?, ?)');
  insertEvent.run(ids.job, 'queued', at, JSON.stringify(replayDetail));
  insertEvent.run(ids.job, 'done', at, null);

  const insertConversation = db.prepare(`INSERT INTO conversations
    (id, user_id, title, summary, summary_through, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)`);
  insertConversation.run(ids.conversation, opaqueUuid, userText, null, at, at);
  insertConversation.run(ids.emptyConversation, userText, opaqueUuid, null, at, at);
  const insertMessage = db.prepare(`INSERT INTO messages
    (id, conversation_id, role, content, citations, attachments, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insertMessage.run(ids.userMessage, ids.conversation, 'user', userText, citations,
    JSON.stringify([ids.upload, ids.secondUpload, legacyUuidToStorage(ids.storedAttachment)]), context, at);
  insertMessage.run(ids.assistantMessage, ids.conversation, 'assistant', opaqueUuid, citations, '[]', context, at);
  db.prepare('UPDATE conversations SET summary_through = ? WHERE id = ?').run(ids.assistantMessage, ids.conversation);
  const insertMember = db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)');
  insertMember.run(ids.conversation, 1, 'owner');
  insertMember.run(ids.conversation, 2, 'viewer');
  insertMember.run(ids.emptyConversation, 1, 'owner');

  const insertUpload = db.prepare(`INSERT INTO uploads
    (id, user_id, name, media_type, size, created_at) VALUES (?, 1, ?, 'text/plain', 42, ?)`);
  for (const id of [ids.upload, ids.secondUpload, ids.storedAttachment]) insertUpload.run(id, opaqueUuid, at);
  const insertGeneration = db.prepare(`INSERT INTO generations
    (id, conversation_id, user_message_id, assistant_message_id, user_id, client_id, status, created_at)
    VALUES (?, ?, ?, ?, 1, ?, 'completed', ?)`);
  insertGeneration.run(ids.generation, ids.conversation, ids.userMessage, ids.assistantMessage, opaqueUuid, at);
  insertGeneration.run(ids.nullableGeneration, ids.emptyConversation, null, null, null, at);
  db.prepare('INSERT INTO generation_frames (generation_id, seq, event, data) VALUES (?, 1, ?, ?)')
    .run(ids.generation, 'done', JSON.stringify(replayFrame));

  db.prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
    VALUES (?, 1, ?, ?, ?, ?)`).run(ids.apiToken, opaqueUuid, opaqueUuid, '["mcp"]', at);
  db.prepare(`INSERT INTO dream_runs
    (id, started_at, status, summary, changed_paths, journal_path, from_sha, to_sha, merge_sha, push_sha)
    VALUES (?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?)`)
    .run(ids.dream, at, userText, JSON.stringify([notePath]), notePath, opaqueUuid, opaqueUuid, opaqueUuid, opaqueUuid);
  const insertImport = db.prepare(`INSERT INTO imports
    (id, user_id, kind, source, status, raw_paths, job_id, sha, created_at, updated_at)
    VALUES (?, 1, 'text', ?, 'succeeded', ?, ?, ?, ?, ?)`);
  insertImport.run(ids.import, `upload:${ids.upload}`, JSON.stringify([notePath]), ids.job, opaqueUuid, at, at);
  insertImport.run(ids.nullableImport, opaqueUuid, JSON.stringify([notePath]), null, opaqueUuid, at, at);
  insertImport.run(ids.opaqueImport, `upload:${opaqueUuid}/suffix`, JSON.stringify([notePath]), null, opaqueUuid, at, at);

  const insertAudit = db.prepare(`INSERT INTO audit_events
    (actor_id, action, target, outcome, summary, created_at) VALUES (1, 'update', ?, 'success', ?, ?)`);
  insertAudit.run(ids.job, userText, at);
  insertAudit.run(`${ids.conversation}/2`, opaqueUuid, at);
  insertAudit.run('user:2', userText, at);

  // OAuth identities and secrets are opaque even when they happen to look like UUIDs.
  db.prepare("INSERT INTO web_sessions (id_hash, user_id, expires_at) VALUES (?, 1, ?)").run(opaqueUuid, at);
  db.prepare(`INSERT INTO auth_pending (state_hash, nonce, verifier, flow, expires_at, browser_hash)
    VALUES (?, ?, ?, ?, ?, ?)`).run(opaqueUuid, opaqueUuid, opaqueUuid, JSON.stringify({ text: userText }), at, opaqueUuid);
  db.prepare("INSERT INTO oauth_clients (client_id, kind, metadata) VALUES (?, 'dcr', ?)")
    .run(opaqueUuid, JSON.stringify({ client_name: opaqueUuid }));
  db.prepare(`INSERT INTO oauth_codes
    (code_hash, client_id, user_id, redirect_uri, challenge, resource, expires_at) VALUES (?, ?, 1, ?, ?, ?, ?)`)
    .run(opaqueUuid, opaqueUuid, `https://example.com/${opaqueUuid}`, opaqueUuid, notePath, at);
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens']) {
    db.prepare(`INSERT INTO ${table} (token_hash, client_id, user_id, family_id, resource, expires_at)
      VALUES (?, ?, 1, ?, ?, ?)`).run(opaqueUuid, opaqueUuid, opaqueUuid, notePath, at);
  }
  db.prepare(`INSERT INTO chunks
    (id, path, title, heading, content, embedding_text, content_hash, kind, ordinal)
    VALUES (1, ?, ?, ?, ?, ?, ?, 'wiki', 0)`)
    .run(notePath, opaqueUuid, userText, userText, userText, opaqueUuid);
  db.prepare('INSERT INTO links (source_path, target_name, target_path, target_text) VALUES (?, ?, ?, ?)')
    .run(notePath, opaqueUuid, notePath, userText);
  db.prepare(`INSERT INTO acl_rules (prefix, subject_type, subject, access, created_by, created_at)
    VALUES (?, 'user', '2', 'read', 1, ?)`).run(notePath, at);
}

type IdInventory = { table: string; columns: string[]; rows: Array<Array<string | null>> };
const idInventory: IdInventory[] = [
  { table: 'write_jobs', columns: ['id'], rows: [[ids.job], [ids.nonChatJob], [ids.opaqueChatJob]] },
  { table: 'write_job_events', columns: ['job_id'], rows: [[ids.job], [ids.job]] },
  { table: 'conversations', columns: ['id', 'summary_through'], rows: [[ids.conversation, ids.assistantMessage], [ids.emptyConversation, null]] },
  { table: 'messages', columns: ['id', 'conversation_id'], rows: [[ids.userMessage, ids.conversation], [ids.assistantMessage, ids.conversation]] },
  { table: 'conversation_members', columns: ['conversation_id'], rows: [[ids.conversation], [ids.conversation], [ids.emptyConversation]] },
  { table: 'uploads', columns: ['id'], rows: [[ids.upload], [ids.secondUpload], [ids.storedAttachment]] },
  { table: 'generations', columns: ['id', 'conversation_id', 'user_message_id', 'assistant_message_id'], rows: [
    [ids.generation, ids.conversation, ids.userMessage, ids.assistantMessage],
    [ids.nullableGeneration, ids.emptyConversation, null, null],
  ] },
  { table: 'generation_frames', columns: ['generation_id'], rows: [[ids.generation]] },
  { table: 'api_tokens', columns: ['id'], rows: [[ids.apiToken]] },
  { table: 'dream_runs', columns: ['id'], rows: [[ids.dream]] },
  { table: 'imports', columns: ['id', 'job_id'], rows: [[ids.import, ids.job], [ids.nullableImport, null], [ids.opaqueImport, null]] },
];

const preservedQueries = [
  'SELECT * FROM users ORDER BY id',
  'SELECT user_id, kind, source, input, status, summary, commits, conflicts, merge_sha, error, created_at, started_at, finished_at FROM write_jobs ORDER BY rowid',
  'SELECT seq, phase, at FROM write_job_events ORDER BY seq',
  'SELECT user_id, title, summary, created_at, updated_at FROM conversations ORDER BY rowid',
  'SELECT role, content, citations, context, created_at, learned_at, status, usage, model, effort FROM messages ORDER BY rowid',
  'SELECT user_id, role FROM conversation_members ORDER BY rowid',
  'SELECT user_id, name, media_type, size, created_at, purpose, saved_at FROM uploads ORDER BY rowid',
  'SELECT user_id, client_id, status, model, effort, created_at, finished_at FROM generations ORDER BY rowid',
  'SELECT seq, event FROM generation_frames ORDER BY rowid',
  'SELECT user_id, name, token_hash, scopes, created_at, expires_at, last_used_at, revoked_at FROM api_tokens ORDER BY rowid',
  'SELECT started_at, finished_at, status, from_sha, to_sha, merge_sha, pushed, error, summary, changed_paths, journal_path, push_status, push_remote, push_sha, push_at, push_reason FROM dream_runs ORDER BY rowid',
  'SELECT user_id, kind, sha, status, raw_paths, error, created_at, updated_at, finished_at FROM imports ORDER BY rowid',
  'SELECT id, actor_id, action, outcome, summary, created_at FROM audit_events ORDER BY id',
  ...['web_sessions', 'auth_pending', 'oauth_clients', 'oauth_codes', 'oauth_access_tokens', 'oauth_refresh_tokens', 'chunks', 'links', 'acl_rules', 'acl_policy', 'user_id_highwater', 'settings']
    .map((table) => `SELECT * FROM ${table} ORDER BY rowid`),
];

function assertMigratedIds(db: Db): void {
  for (const { table, columns, rows } of idInventory) {
    const actual = db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid`).all() as Array<Record<string, string | null>>;
    const expected = rows.map((row) => Object.fromEntries(columns.map((column, index) => [
      column, row[index] === null ? null : legacyUuidToStorage(row[index]!),
    ])));
    expect(actual, table).toEqual(expected);
    const apiRows = actual.map((row) => Object.fromEntries(columns.map((column) => [
      column, row[column] === null ? null : fromStorageId(row[column]!),
    ])));
    expect(apiRows, `${table} API identities`).toEqual(rows.map((row) => Object.fromEntries(columns.map((column, index) => [
      column, row[index] === null ? null : legacyUuidToApi(row[index]!),
    ]))));
  }
  const attachments = db.prepare('SELECT attachments FROM messages ORDER BY rowid').all() as Array<{ attachments: string }>;
  expect(attachments.map((row) => JSON.parse(row.attachments))).toEqual([
    [ids.upload, ids.secondUpload, ids.storedAttachment].map(legacyUuidToStorage),
    [],
  ]);
  expect((JSON.parse(attachments[0]!.attachments) as string[]).map(fromStorageId))
    .toEqual([ids.upload, ids.secondUpload, ids.storedAttachment].map(legacyUuidToApi));
  const detail = db.prepare('SELECT detail FROM write_job_events ORDER BY seq').all() as Array<{ detail: string | null }>;
  expect(JSON.parse(detail[0]!.detail!)).toEqual({
    jobId: legacyUuidToApi(ids.job),
    nested: {
      conversationId: legacyUuidToApi(ids.conversation),
      messages: [legacyUuidToApi(ids.userMessage), { id: legacyUuidToApi(ids.assistantMessage) }],
      uploadIds: [legacyUuidToApi(ids.upload), legacyUuidToApi(ids.secondUpload)],
      alreadyApi: replayDetail.nested.alreadyApi,
      untouched: replayDetail.nested.untouched,
    },
  });
  expect(detail[1]).toEqual({ detail: null });
  const frame = db.prepare('SELECT data FROM generation_frames').get() as { data: string };
  expect(JSON.parse(frame.data)).toEqual({
    generationId: legacyUuidToApi(ids.generation),
    message: { id: legacyUuidToApi(ids.assistantMessage), conversationId: legacyUuidToApi(ids.conversation) },
    nested: [{ uploadId: legacyUuidToApi(ids.upload) }, [legacyUuidToApi(ids.userMessage), { jobId: legacyUuidToApi(ids.job) }]],
    alreadyApi: replayFrame.alreadyApi,
    untouched: replayFrame.untouched,
  });
  expect(db.prepare('SELECT target FROM audit_events ORDER BY id').all()).toEqual([
    { target: legacyUuidToApi(ids.job) },
    { target: `${legacyUuidToApi(ids.conversation)}/2` },
    { target: 'user:2' },
  ]);
  expect(db.prepare('SELECT client, dedupe_key FROM write_jobs ORDER BY rowid').all()).toEqual([
    {
      client: legacyUuidToApi(ids.conversation),
      dedupe_key: `chat:${legacyUuidToApi(ids.conversation)}:${legacyUuidToApi(ids.userMessage)}:1:${revision}:1`,
    },
    { client: opaqueUuid, dedupe_key: opaqueDedupeKey },
    { client: `conversation:${opaqueUuid}`, dedupe_key: malformedChatDedupeKey },
  ]);
  expect(db.prepare('SELECT source FROM imports ORDER BY rowid').all()).toEqual([
    { source: `upload:${legacyUuidToApi(ids.upload)}` },
    { source: opaqueUuid },
    { source: `upload:${opaqueUuid}/suffix` },
  ]);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('foreign_key_check')).toEqual([]);
}


function migratedSnapshot(db: Db): unknown[] {
  return [...idInventory.map(({ table }) => `SELECT * FROM ${table} ORDER BY rowid`),
    'SELECT * FROM audit_events ORDER BY id',
    'SELECT * FROM schema_migrations ORDER BY name',
    ...preservedQueries].map((sql) => db.prepare(sql).all());
}

describe('identifier database migration', () => {
  it('converts every historical identifier and replay document without changing user data or breaking references', () => {
    const db = openDb(':memory:');
    try {
      migrateHistoricalDb(db);
      seedHistoricalDb(db);
      const preserved = preservedQueries.map((sql) => db.prepare(sql).all());
      expect(db.pragma('foreign_key_check')).toEqual([]);

      runMigrations(db);

      assertMigratedIds(db);
      const malformedJson = `{"id":"${ids.job}",`;
      expect(db.prepare('SELECT legacy_json_ids_to_api(?) AS value').get(malformedJson)).toEqual({ value: malformedJson });
      expect(preservedQueries.map((sql) => db.prepare(sql).all())).toEqual(preserved);
      const migrated = migratedSnapshot(db);
      runMigrations(db);
      expect(migratedSnapshot(db)).toEqual(migrated);
      // Bypass the ledger to prove the SQL itself tolerates storage/API values and NULLs.
      db.transaction(() => db.exec(identifierMigrationSql))();
      expect(migratedSnapshot(db)).toEqual(migrated);
      assertMigratedIds(db);
    } finally {
      db.close();
    }
  });

  it('migrates an empty database and safely reapplies the identifier SQL', () => {
    const db = openDb(':memory:');
    try {
      runMigrations(db);
      for (const { table } of idInventory) {
        expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([]);
      }
      expect(db.prepare('SELECT * FROM audit_events').all()).toEqual([]);
      const migrated = migratedSnapshot(db);
      db.transaction(() => db.exec(identifierMigrationSql))();
      runMigrations(db);
      expect(migratedSnapshot(db)).toEqual(migrated);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
