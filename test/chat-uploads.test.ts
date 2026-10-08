import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadsController } from '../src/api/uploads.controller.js';
import { RolesGuard } from '../src/auth/guards/roles.guard.js';
import { SessionGuard } from '../src/auth/guards/session.guard.js';
import { UsersRepository } from '../src/auth/users.repository.js';
import { UsersService } from '../src/auth/users.service.js';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';
import { CONFIG, DB, LOGGER } from '../src/common/tokens.js';
import { loadConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { EventsService } from '../src/events/events.service.js';
import { NoteWriterService } from '../src/jobs/note-writer.service.js';
import { WriteJobsRepository } from '../src/jobs/write-jobs.repository.js';
import { KnowledgeRepo } from '../src/knowledge/repo.js';
import type { IndexerService } from '../src/rag/indexer.service.js';
import { CHAT_UPLOAD_LIMIT, UploadsService, type Upload } from '../src/uploads/uploads.service.js';
import { AclService } from '../src/acl/acl.service.js';
import { AuditService } from '../src/audit/audit.service.js';

const stamp = '2026-01-01T00:00:00.000Z';
const schemas = ['001_core.sql', '002_auth.sql', '003_jobs.sql', '004_chat.sql', '007_history.sql', '010_chat.sql', '011_platform.sql', '013_acl.sql', '017_write_job_dedupe.sql'].map((name) =>
  readFileSync(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1H8AAAAASUVORK5CYII=', 'base64');
let directory: string;
let db: Db;
let app: INestApplication;
let uploads: UploadsService;
let repo: KnowledgeRepo;

beforeEach(async () => {
  vi.stubEnv('UPLOAD_RETENTION_DAYS', '7');
  directory = mkdtempSync(join(tmpdir(), 'chat-uploads-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory });
  const logger = pino({ level: 'silent' });
  db = openDb(':memory:');
  for (const schema of schemas) db.exec(schema);
  for (const [id, role] of [[1, 'editor'], [2, 'viewer'], [3, 'admin']] as const) {
    db.prepare('INSERT INTO users(id,email,name,role,created_at) VALUES (?,?,?,?,?)').run(id, `${id}@example.test`, `User ${id}`, role, stamp);
  }
  const users = new UsersService(new UsersRepository(db));
  repo = await KnowledgeRepo.open(config, logger);
  const events = new EventsService();
  const indexer = { syncToHead: async () => ({ indexedSha: await repo.headSha(), changedFiles: 1 }) } as IndexerService;
  const repository = new WriteJobsRepository(db);
  const acl = new AclService(db, users, new AuditService(db));
  const writer = new NoteWriterService(repository, repo, users, indexer, events, logger, acl);
  const module = await Test.createTestingModule({
    controllers: [UploadsController],
    providers: [UploadsService, RolesGuard, { provide: CONFIG, useValue: config }, { provide: DB, useValue: db },
      { provide: AclService, useValue: acl },
      { provide: LOGGER, useValue: logger }, { provide: NoteWriterService, useValue: writer }],
  }).overrideGuard(SessionGuard).useValue({
    canActivate(context: { switchToHttp(): { getRequest(): Request } }) {
      const req = context.switchToHttp().getRequest();
      req.user = users.getById(Number(req.headers['x-user'])) ?? undefined;
      return !!req.user;
    },
  }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  await app.init();
  uploads = app.get(UploadsService);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await app?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('owner-scoped multipart uploads', () => {
  it('sniffs bytes rather than filename and client MIME; downloads only for the owner with safe headers', async () => {
    const posted = await request(app.getHttpServer()).post('/api/uploads').set('x-user', '1')
      .attach('file', png, { filename: 'wrong.txt', contentType: 'text/plain' }).expect(201);
    const upload = posted.body as Upload;
    expect(upload.mediaType).toBe('image/png');
    expect(upload.purpose).toBe('chat');
    const downloaded = await request(app.getHttpServer()).get(`/api/uploads/${upload.id}`).set('x-user', '1').expect(200);
    expect(downloaded.body).toEqual(png);
    expect(downloaded.headers['content-type']).toBe('image/png');
    expect(downloaded.headers['content-disposition']).toBe('attachment; filename="wrong.txt"; filename*=UTF-8\'\'wrong.txt');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    await request(app.getHttpServer()).get(`/api/uploads/${upload.id}`).set('x-user', '2').expect(404);
    await request(app.getHttpServer()).get(`/api/uploads/${upload.id}`).set('x-user', '3').expect(404);
  });

  it('rejects binary disguised as text and invalid UTF-8, but accepts valid markdown and missing MIME', async () => {
    for (const buffer of [Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), Buffer.from([0xc3, 0x28]), Buffer.from('hello\u0000world')]) {
      await request(app.getHttpServer()).post('/api/uploads').set('x-user', '1')
        .attach('file', buffer, { filename: 'fake.md', contentType: 'text/markdown' }).expect(415);
    }
    const posted = await request(app.getHttpServer()).post('/api/uploads').set('x-user', '2')
      .attach('file', Buffer.from('# 안녕\n문서\n'), { filename: 'note.md', contentType: 'application/octet-stream' }).expect(201);
    expect(posted.body.mediaType).toBe('text/markdown');
    expect(await uploads.parts(2, [posted.body.id])).toEqual([{ type: 'input_text', text: 'Attachment: note.md\n# 안녕\n문서\n' }]);
    await request(app.getHttpServer()).post('/api/uploads').set('x-user', '1').expect(400);
  });

  it('accepts the 20MiB chat boundary and refuses larger files regardless of their MIME', async () => {
    await request(app.getHttpServer()).post('/api/uploads').set('x-user', '1')
      .attach('file', Buffer.alloc(CHAT_UPLOAD_LIMIT, 65), { filename: 'limit.txt' }).expect(201);
    await request(app.getHttpServer()).post('/api/uploads').set('x-user', '1')
      .attach('file', Buffer.alloc(CHAT_UPLOAD_LIMIT + 1, 65), { filename: 'large.txt' }).expect(413);
  });

  it('allows editor import ZIPs above the chat limit but blocks viewers and chat replay', async () => {
    const zip = Buffer.alloc(CHAT_UPLOAD_LIMIT + 1);
    Buffer.from([80, 75, 3, 4]).copy(zip);
    const imported = await request(app.getHttpServer()).post('/api/uploads').set('x-user', '1').field('purpose', 'import')
      .attach('file', zip, { filename: 'vault.txt', contentType: 'text/plain' }).expect(201);
    expect(imported.body).toMatchObject({ purpose: 'import', mediaType: 'application/zip' });
    await expect(uploads.parts(1, [imported.body.id], 0)).rejects.toMatchObject({ status: 400, code: 'invalid_attachment' });
    await request(app.getHttpServer()).post('/api/uploads').set('x-user', '2').field('purpose', 'import')
      .attach('file', Buffer.from([80, 75, 5, 6]), { filename: 'empty.zip' }).expect(403);
    await request(app.getHttpServer()).post('/api/uploads').set('x-user', '1').field('purpose', 'unknown')
      .attach('file', png, { filename: 'image.png' }).expect(400);
  });

  it('encodes quotes and Unicode in downloads without turning filenames into headers or paths', async () => {
    const upload = await uploads.save(1, { name: '../인용"\r\nname.txt', mediaType: 'text/plain', buffer: Buffer.from('safe') });
    const result = await request(app.getHttpServer()).get(`/api/uploads/${upload.id}`).set('x-user', '1').expect(200);
    expect(result.text).toBe('safe');
    expect(result.headers['content-disposition']).toBe('attachment; filename="___name.txt"; filename*=UTF-8\'\'%EC%9D%B8%EC%9A%A9%22name.txt');
  });
});

describe('chat replay and retained assets', () => {
  it('maps image/PDF bytes to SDK content and caps text on a valid UTF-8 boundary', async () => {
    const image = await uploads.save(1, { name: 'image.png', mediaType: 'image/png', buffer: png });
    const pdf = await uploads.save(1, { name: 'paper.pdf', mediaType: 'image/png', buffer: Buffer.from('%PDF-1.7\nexample') });
    const text = await uploads.save(1, { name: 'long.md', mediaType: 'text/markdown', buffer: Buffer.from('a'.repeat(32767) + '한글') });
    expect(await uploads.parts(1, [image.id, pdf.id, text.id])).toEqual([
      { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}`, detail: 'auto' },
      { type: 'input_file', filename: 'paper.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjcKZXhhbXBsZQ==' },
      { type: 'input_text', text: 'Attachment: long.md\n' + 'a'.repeat(32767) },
    ]);
  });

  it('enforces replay budgets while still validating missing and foreign IDs after skipped files', async () => {
    const image = await uploads.save(1, { name: 'image.png', mediaType: 'image/png', buffer: png });
    const text = await uploads.save(1, { name: 'short.txt', mediaType: 'text/plain', buffer: Buffer.from('ok') });
    expect(await uploads.parts(1, [image.id, text.id], 2)).toEqual([{ type: 'input_text', text: 'Attachment: short.txt\nok' }]);
    await expect(uploads.parts(1, [image.id, 'missing'], 0)).rejects.toMatchObject({ status: 404 });
    await expect(uploads.parts(2, [image.id], 0)).rejects.toMatchObject({ status: 404 });
    const big = Buffer.alloc(14 * 1024 * 1024);
    Buffer.from('%PDF-1.7\n').copy(big);
    const first = await uploads.save(1, { name: 'a.pdf', mediaType: 'application/pdf', buffer: big });
    const second = await uploads.save(1, { name: 'b.pdf', mediaType: 'application/pdf', buffer: big });
    expect((await uploads.parts(1, [first.id, second.id])).map((part) => part.type === 'input_file' ? part.filename : null)).toEqual(['a.pdf']);
  });

  it('writes actual asset bytes through NoteWriter, rejects unsafe paths and retains only saved/attached uploads', async () => {
    const saved = await uploads.save(1, { name: 'pixel.png', mediaType: 'image/png', buffer: png });
    const discarded = await uploads.save(1, { name: 'orphan.txt', mediaType: 'text/plain', buffer: Buffer.from('unused') });
    const attached = await uploads.save(1, { name: 'attached.txt', mediaType: 'text/plain', buffer: Buffer.from('used') });
    db.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES (?,1,?,?,?)').run('c', 'Conversation', stamp, stamp);
    db.prepare("INSERT INTO messages(id,conversation_id,role,content,citations,created_at,attachments) VALUES ('m','c','user','Question','[]',?,?)")
      .run(stamp, JSON.stringify([attached.id]));
    const baseSha = await repo.headSha();
    for (const path of ['../assets/pixel.png', 'assets/../wiki/file.md', 'assets\\pixel.png', 'assets//pixel.png', '/assets/pixel.png']) {
      await request(app.getHttpServer()).post(`/api/uploads/${saved.id}/save`).set('x-user', '1').send({ path, baseSha }).expect(400);
    }
    await request(app.getHttpServer()).post(`/api/uploads/${saved.id}/save`).set('x-user', '2').send({ path: 'assets/pixel.png', baseSha }).expect(403);
    await request(app.getHttpServer()).post(`/api/uploads/${saved.id}/save`).set('x-user', '3').send({ path: 'assets/pixel.png', baseSha }).expect(404);
    const result = await request(app.getHttpServer()).post(`/api/uploads/${saved.id}/save`).set('x-user', '1')
      .send({ path: 'assets/pixel.png', baseSha }).expect(201);
    expect(result.body.mergeSha).toBe(await repo.headSha());
    const stale = await request(app.getHttpServer()).post(`/api/uploads/${discarded.id}/save`).set('x-user', '1')
      .send({ path: 'assets/pixel.png', baseSha }).expect(409);
    expect(stale.body.error.code).toBe('stale_note');
    expect(readFileSync(join(directory, 'knowledge/assets/pixel.png'))).toEqual(png);
    const replacementBytes = Buffer.concat([png, Buffer.from('updated')]);
    const replacement = await uploads.save(1, { name: 'replacement.png', mediaType: 'image/png', buffer: replacementBytes });
    await request(app.getHttpServer()).post(`/api/uploads/${replacement.id}/save`).set('x-user', '1')
      .send({ path: 'assets/pixel.png', baseSha: result.body.mergeSha }).expect(201);
    expect(readFileSync(join(directory, 'knowledge/assets/pixel.png'))).toEqual(replacementBytes);
    const orphanPath = join(directory, 'uploads', 'crashed-before-insert');
    writeFileSync(orphanPath, 'orphan');
    utimesSync(orphanPath, new Date(stamp), new Date(stamp));
    expect(uploads.cleanup(Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe(2);
    expect(() => uploads.get(1, discarded.id)).toThrow('Upload not found');
    expect(readFileSync(uploads.get(1, saved.id).path)).toEqual(png);
    expect(readFileSync(uploads.get(1, attached.id).path, 'utf8')).toBe('used');
  });

  it('runs cleanup on startup and periodically without removing recent uploads', async () => {
    const old = await uploads.save(1, { name: 'old.txt', mediaType: 'text/plain', buffer: Buffer.from('old') });
    const fresh = await uploads.save(1, { name: 'fresh.txt', mediaType: 'text/plain', buffer: Buffer.from('fresh') });
    db.prepare('UPDATE uploads SET created_at = ? WHERE id = ?').run(stamp, old.id);
    uploads.onModuleDestroy();
    vi.useFakeTimers();
    uploads.onModuleInit();
    expect(() => uploads.get(1, old.id)).toThrow('Upload not found');
    expect(readFileSync(uploads.get(1, fresh.id).path, 'utf8')).toBe('fresh');
    await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
    expect(() => uploads.get(1, fresh.id)).toThrow('Upload not found');
  });
});
