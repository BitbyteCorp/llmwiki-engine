import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response as ExpressResponse } from 'express';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiTokensRepository } from '../auth/api-tokens.repository.js';
import { ApiTokensService } from '../auth/api-tokens.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { configureApp } from '../common/http/configure-app.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPaQAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

describe('raw note assets HTTP with real Git and viewer sessions', () => {
  let directory: string;
  let db: Db;
  let app: INestApplication;
  let server: Server;
  let origin: string;
  let cookie: string;
  let repo: KnowledgeRepo;
  let worktree: Worktree;
  let firstRef: string;
  let acl: AclService;
  let admin: User;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'llmwiki-notes-raw-'));
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:3000' });
    const log = pino({ level: 'silent' });
    db = openDb(join(directory, 'wiki.db'));
    runMigrations(db);
    repo = await KnowledgeRepo.open(config, log);
    worktree = await repo.createWorktree('raw-assets');
    await worktree.write('assets/picture.bin', png);
    await worktree.write('assets/nested/한글 image.png', gif);
    await worktree.write('assets/active.png', '<html><script>alert(1)</script></html>');
    await worktree.write('assets/active.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    await symlink('picture.bin', join(worktree.path, 'assets/link.png'));
    firstRef = (await worktree.commit('Store asset fixtures', { name: 'Editor', email: 'editor@example.test' }))!;
    await worktree.mergeMain();
    await worktree.fastForwardMain();
    const module = await Test.createTestingModule({
      controllers: [NotesController],
      providers: [
        NotesService, UsersService, UsersRepository, SessionsService, ApiTokensService, ApiTokensRepository,
        SessionGuard, RolesGuard, AuditService, AclService,
        { provide: CONFIG, useValue: config },
        { provide: DB, useValue: db },
        { provide: LOGGER, useValue: log },
        { provide: KnowledgeRepo, useValue: repo },
        { provide: NoteWriterService, useValue: {} },
      ],
    }).compile();
    acl = module.get(AclService);
    admin = await module.get(UsersService).create({ email: 'admin@example.test', role: 'admin' });
    const viewer = await module.get(UsersService).create({ email: 'viewer@example.test', role: 'viewer' });
    module.get(SessionsService).create({
      cookie: (name: string, value: string) => { cookie = `${name}=${value}`; },
    } as unknown as ExpressResponse, viewer);
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    app.useGlobalFilters(new HttpExceptionFilter(log));
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as Server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) server.closeAllConnections();
    if (app) await app.close();
    if (worktree) await worktree.dispose();
    if (db?.open) db.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function request(path: string, ref?: string, authenticated = true): Promise<Response> {
    const query = new URLSearchParams({ path, ...(ref === undefined ? {} : { ref }) });
    return fetch(`${origin}/api/notes/raw?${query}`, { headers: authenticated ? { cookie } : {} });
  }

  it('does not expose asset bytes at current or historical revisions when a folder ACL denies the viewer', async () => {
    acl.create({ prefix: 'assets/', subjectType: 'role', subject: 'viewer', access: 'none' }, admin);
    for (const ref of [undefined, firstRef]) {
      const response = await request('assets/picture.bin', ref);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });

  it('serves exact committed bytes to viewers, detects MIME from bytes and does not expose uncommitted files', async () => {
    await writeFile(join(directory, 'knowledge/assets/picture.bin'), gif);
    const response = await request('assets/picture.bin');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    const nested = await request('assets/nested/한글 image.png');
    expect(nested.status).toBe(200);
    expect(nested.headers.get('content-type')).toBe('image/gif');
    expect(Buffer.from(await nested.arrayBuffer())).toEqual(gif);
  });

  it('pins historical bytes while main advances and returns missing for an asset absent at the requested revision', async () => {
    const beforeAsset = await repo.resolveRef(`${firstRef}^`);
    await worktree.write('assets/picture.bin', gif);
    await worktree.commit('Replace image', { name: 'Editor', email: 'editor@example.test' });
    await worktree.mergeMain();
    await worktree.fastForwardMain();
    const historical = await request('assets/picture.bin', firstRef);
    expect(historical.status).toBe(200);
    expect(historical.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await historical.arrayBuffer())).toEqual(png);
    const current = await request('assets/picture.bin');
    expect(current.status).toBe(200);
    expect(current.headers.get('content-type')).toBe('image/gif');
    expect(Buffer.from(await current.arrayBuffer())).toEqual(gif);
    expect((await request('assets/picture.bin', beforeAsset)).status).toBe(404);
  });

  it('revalidates SHA-addressed assets without bypassing revoked folder permissions', async () => {
    const url = `${origin}/api/notes/raw?${new URLSearchParams({ path: 'assets/picture.bin', ref: firstRef })}`;
    const initial = await fetch(url, { headers: { cookie } });
    const etag = initial.headers.get('etag')!;
    expect(initial.status).toBe(200);
    expect(initial.headers.get('cache-control')).toBe('private, no-cache');
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const unchanged = await fetch(url, { headers: { cookie, 'if-none-match': etag, 'cache-control': 'max-age=0' } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    acl.create({ prefix: 'assets/', subjectType: 'role', subject: 'viewer', access: 'none' }, admin);
    const denied = await fetch(url, { headers: { cookie, 'if-none-match': etag, 'cache-control': 'max-age=0' } });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it.each([
    '../assets/picture.bin', 'assets/../index.md', 'assets/./picture.bin', '/assets/picture.bin',
    'C:/assets/picture.bin', 'assets\\picture.bin', 'assets/.git/config', 'assets/.GIT/config',
    '.git/config', 'index.md', 'assets//picture.bin', 'assets/picture.bin\0',
  ])('rejects unsafe or non-asset path %s', async (path) => {
    const response = await request(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it.each(['assets/active.png', 'assets/active.svg'])('does not serve active content as an image: %s', async (path) => {
    const response = await request(path);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
  });

  it('denies Git symlinks rather than following them', async () => {
    const response = await request('assets/link.png');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('returns missing for unknown paths and references, and requires authentication', async () => {
    expect((await request('assets/missing.png')).status).toBe(404);
    expect((await request('assets/picture.bin', 'missing-reference')).status).toBe(404);
    const anonymous = await request('assets/picture.bin', undefined, false);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });
});
