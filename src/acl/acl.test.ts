import 'reflect-metadata';
import { Global, HttpException, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { configureApp } from '../common/http/configure-app.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { AclModule } from './acl.module.js';
import { AclService } from './acl.service.js';

let database: Db;

@Global()
@Module({
  providers: [
    { provide: DB, useFactory: () => database },
    { provide: CONFIG, useValue: loadConfig({ NODE_ENV: 'test' }) },
    { provide: LOGGER, useValue: { error() {} } },
  ],
  exports: [DB, CONFIG, LOGGER],
})
class AclTestInfrastructure {}

describe('repository path access policy', () => {
  let app: INestApplication;
  let acl: AclService;
  let users: UsersService;
  let audit: AuditService;
  let admin: User;
  let editor: User;
  let viewer: User;
  let otherEditor: User;

  beforeEach(async () => {
    database = openDb(':memory:');
    runMigrations(database);
    const module = await Test.createTestingModule({ imports: [AclTestInfrastructure, AclModule] })
      .overrideProvider(SessionsService).useValue({
        sessionUser(req: Request) { return users.getById(Number(req.get('x-user'))); },
        assertSameOrigin() {},
      }).compile();
    users = module.get(UsersService);
    admin = users.create({ email: 'admin@example.com', role: 'admin' });
    editor = users.create({ email: 'editor@example.com', role: 'editor' });
    viewer = users.create({ email: 'viewer@example.com', role: 'viewer' });
    otherEditor = users.create({ email: 'other@example.com', role: 'editor' });
    acl = module.get(AclService);
    audit = module.get(AuditService);
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    app.useGlobalFilters(new HttpExceptionFilter({ error() {} } as never));
    await app.init();
  });

  afterEach(async () => { await app?.close(); if (database?.open) database.close(); });

  it('uses role defaults, caps viewer grants, and bypasses rules for admins', () => {
    expect(acl.explain(viewer, 'notes/one.md')).toEqual({ userId: viewer.id, path: 'notes/one.md', access: 'read', rule: null, reason: 'role_default' });
    expect(acl.access(editor, 'notes/one.md')).toBe('write');
    acl.create({ prefix: '/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    const grant = acl.create({ prefix: 'notes/', subjectType: 'role', subject: 'viewer', access: 'write' }, admin);
    expect(acl.explain(viewer, 'notes/one.md')).toMatchObject({ access: 'read', rule: grant, reason: 'rule' });
    expect(acl.canWrite(viewer, 'notes/one.md')).toBe(false);
    expect(acl.explain(admin, 'private/secret.md')).toEqual({ userId: admin.id, path: 'private/secret.md', access: 'write', rule: null, reason: 'admin' });
    expect(acl.access(editor, 'private/secret.md')).toBe('none');
  });

  it('selects longest applicable prefix before user, role, and everyone precedence', () => {
    acl.create({ prefix: '/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    acl.create({ prefix: 'notes/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    const roleRule = acl.create({ prefix: 'notes/', subjectType: 'role', subject: 'editor', access: 'read' }, admin);
    const userRule = acl.create({ prefix: 'notes/', subjectType: 'user', subject: editor.id, access: 'write' }, admin);
    const exactRule = acl.create({ prefix: 'notes/one.md', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    acl.create({ prefix: 'notes/deep/', subjectType: 'user', subject: viewer.id, access: 'none' }, admin);
    const deepRule = acl.create({ prefix: 'notes/deep/', subjectType: 'everyone', subject: '', access: 'read' }, admin);
    expect(acl.explain(editor, 'notes/two.md').rule).toEqual(userRule);
    expect(acl.explain(otherEditor, 'notes/two.md').rule).toEqual(roleRule);
    expect(acl.explain(editor, 'notes/one.md').rule).toEqual(exactRule);
    expect(acl.explain(editor, 'notes/deep/three.md').rule).toEqual(deepRule);
    expect(acl.access(editor, 'notes/one.md.backup')).toBe('write');
    expect(acl.access(editor, 'notes-other/two.md')).toBe('none');
    expect(acl.filterPaths(editor, ['notes/two.md', 'notes/one.md', 'notes-other/two.md'])).toEqual(['notes/two.md']);
  });

  it('treats root as less specific than a one-character exact file in service and SQL', () => {
    const rootGrant = acl.create({ prefix: '/', subjectType: 'user', subject: editor.id, access: 'write' }, admin);
    const exactDenial = acl.create({ prefix: 'a', subjectType: 'everyone', access: 'none' }, admin);
    expect(acl.access(editor, 'a')).toBe('none');
    expect(acl.explain(editor, 'a').rule).toEqual(exactDenial);
    expect(acl.explain(editor, 'b').rule).toEqual(rootGrant);
    const predicate = acl.sql(editor, 'p.path');
    expect(database.prepare(`SELECT p.path FROM (SELECT 'a' AS path UNION ALL SELECT 'b') p WHERE ${predicate.sql} ORDER BY p.path`)
      .all(...predicate.params)).toEqual([{ path: 'b' }]);
  });

  it('hides unreadable paths while rejecting writes to readable-only paths', () => {
    acl.create({ prefix: 'private/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    acl.create({ prefix: 'readonly/', subjectType: 'everyone', subject: '', access: 'read' }, admin);
    for (const operation of [() => acl.assertRead(editor, 'private/one.md'), () => acl.assertWrite(editor, 'private/one.md')]) {
      try { operation(); throw new Error('Expected access denial'); } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        const denied = error as HttpException;
        expect(denied.getStatus()).toBe(404);
        expect(denied.getResponse()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
      }
    }
    try { acl.assertWrite(editor, 'readonly/one.md'); throw new Error('Expected access denial'); } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const denied = error as HttpException;
      expect(denied.getStatus()).toBe(403);
      expect(denied.getResponse()).toEqual({ error: { code: 'forbidden', message: 'Forbidden.' } });
    }
    expect(acl.canRead(editor, 'readonly/one.md')).toBe(true);
    expect(acl.canWrite(editor, 'public/one.md')).toBe(true);
  });

  it('invalidates cached readers and durable cursor policy identity on upsert and deletion', () => {
    const secondReader = new AclService(database, users, audit);
    const before = acl.policyKey(editor);
    expect(secondReader.access(editor, 'notes/one.md')).toBe('write');
    const first = acl.create({ prefix: 'notes/', subjectType: 'everyone', access: 'none' }, admin);
    const inserted = acl.policyKey(editor);
    expect(inserted).not.toBe(before);
    expect(secondReader.access(editor, 'notes/one.md')).toBe('none');
    const updated = acl.create({ prefix: 'notes/', subjectType: 'everyone', access: 'read' }, admin);
    expect(updated).toMatchObject({ id: first.id, createdBy: first.createdBy, createdAt: first.createdAt });
    expect(acl.list()).toEqual([updated]);
    expect(acl.policyKey(editor)).not.toBe(inserted);
    expect(secondReader.access(editor, 'notes/one.md')).toBe('read');
    acl.delete(first.id, admin);
    expect(secondReader.access(editor, 'notes/one.md')).toBe('write');
    expect(secondReader.policyKey(editor)).toBe(acl.policyKey(editor));
    expect(acl.policyKey({ id: editor.id, role: 'viewer' })).not.toBe(acl.policyKey(editor));
  });

  it('captures fresh synchronous read policies with exact prefix, subject and role precedence', () => {
    acl.create({ prefix: '/', subjectType: 'everyone', access: 'none' }, admin);
    acl.create({ prefix: 'notes/', subjectType: 'role', subject: 'editor', access: 'read' }, admin);
    const exact = acl.create({ prefix: 'notes/one.md', subjectType: 'user', subject: editor.id, access: 'none' }, admin);
    acl.create({ prefix: 'notes/deep/', subjectType: 'user', subject: viewer.id, access: 'none' }, admin);
    const paths = ['notes/one.md', 'notes/one.md.backup', 'notes/deep/two.md', 'notes-other/two.md'];
    expect(paths.filter(acl.readPredicate(editor))).toEqual(['notes/one.md.backup', 'notes/deep/two.md']);
    expect(paths.filter(acl.readPredicate(otherEditor))).toEqual(['notes/one.md', 'notes/one.md.backup', 'notes/deep/two.md']);
    expect(paths.filter(acl.readPredicate(viewer))).toEqual([]);
    expect(paths.filter(acl.readPredicate(admin))).toEqual(paths);
    acl.delete(exact.id, admin);
    expect(paths.filter(acl.readPredicate(editor))).toEqual(['notes/one.md', 'notes/one.md.backup', 'notes/deep/two.md']);
    expect(paths.filter(acl.readPredicate({ id: editor.id, role: 'viewer' }))).toEqual([]);
    acl.create({ prefix: 'notes/', subjectType: 'everyone', access: 'read' }, admin);
    expect(paths.filter(acl.readPredicate(viewer))).toEqual(['notes/one.md', 'notes/one.md.backup']);
  });

  it('revokes deleted user grants and gives replacement accounts strictly newer identities', async () => {
    acl.create({ prefix: 'private/', subjectType: 'everyone', access: 'none' }, admin);
    const folderGrant = acl.create({ prefix: 'private/', subjectType: 'user', subject: otherEditor.id, access: 'write' }, admin);
    const fileGrant = acl.create({ prefix: 'private/exact.md', subjectType: 'user', subject: otherEditor.id, access: 'read' }, admin);
    const cachedReader = new AclService(database, users, audit);
    expect(cachedReader.access(otherEditor, 'private/secret.md')).toBe('write');
    const grantedPolicyKey = cachedReader.policyKey(otherEditor);
    users.delete(otherEditor.id);
    expect(cachedReader.policyKey(otherEditor)).not.toBe(grantedPolicyKey);
    expect(cachedReader.access(otherEditor, 'private/secret.md')).toBe('none');
    const replacement = users.create({ email: 'replacement@example.com', role: 'editor' });
    expect(replacement.id).toBeGreaterThan(otherEditor.id);
    expect(cachedReader.policyKey(replacement)).not.toBe(grantedPolicyKey);
    expect(cachedReader.access(replacement, 'private/secret.md')).toBe('none');
    expect(cachedReader.access(replacement, 'private/exact.md')).toBe('none');
    const predicate = acl.sql(replacement, 'p.path');
    expect(database.prepare(`SELECT p.path FROM (SELECT 'private/secret.md' AS path UNION ALL SELECT 'private/exact.md') p WHERE ${predicate.sql}`).all(...predicate.params)).toEqual([]);
    const checked = await request(app.getHttpServer()).get('/api/admin/acl/check').set('x-user', String(admin.id))
      .query({ userId: replacement.id, path: 'private/secret.md' }).expect(200);
    expect(checked.body).toMatchObject({ userId: replacement.id, access: 'none', reason: 'rule', rule: { subjectType: 'everyone' } });
    expect(acl.list().map((rule) => rule.subjectType)).toEqual(['everyone']);
    expect(audit.list({ action: 'acl.delete', limit: 50 }).events.map(({ actorId, target, outcome }) => ({ actorId, target, outcome })).reverse()).toEqual([
      { actorId: null, target: `acl:${folderGrant.id}`, outcome: 'success' },
      { actorId: null, target: `acl:${fileGrant.id}`, outcome: 'success' },
    ]);
  });

  it('preserves identity allocation across deletion, explicit imported IDs, and database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'llmwiki-user-identities-'));
    const file = join(directory, 'users.db');
    let db = openDb(file);
    try {
      runMigrations(db);
      let repository = new UsersRepository(db);
      const createdAt = '2026-01-01T00:00:00.000Z';
      expect(repository.create('first@example.com', null, 'admin', createdAt)).toBe(1);
      db.prepare('INSERT INTO users (id, email, role, created_at) VALUES (?, ?, ?, ?)')
        .run(40, 'imported@example.com', 'editor', createdAt);
      repository.delete(40);
      const afterImport = repository.create('after-import@example.com', null, 'editor', createdAt);
      expect(afterImport).toBe(41);
      repository.delete(afterImport);
      db.close();
      db = openDb(file);
      runMigrations(db);
      repository = new UsersRepository(db);
      expect(repository.create('after-reopen@example.com', null, 'viewer', createdAt)).toBe(42);
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('applies SQL read filtering before limits with literal prefixes and identical precedence', () => {
    database.exec('CREATE TABLE acl_test_paths (path TEXT PRIMARY KEY)');
    for (const path of ['a/secret.md', 'a/visible.md', 'b/fallback.md', 'wild%_/hidden.md', 'wildXX/visible.md']) {
      database.prepare('INSERT INTO acl_test_paths VALUES (?)').run(path);
    }
    acl.create({ prefix: 'a/', subjectType: 'everyone', access: 'none' }, admin);
    acl.create({ prefix: 'a/visible.md', subjectType: 'role', subject: 'editor', access: 'read' }, admin);
    acl.create({ prefix: 'a/visible.md', subjectType: 'user', subject: otherEditor.id, access: 'none' }, admin);
    acl.create({ prefix: 'wild%_/', subjectType: 'everyone', access: 'none' }, admin);
    const predicate = acl.sql(editor, 'p.path');
    expect(database.prepare(`SELECT p.path FROM acl_test_paths p WHERE ${predicate.sql} ORDER BY p.path LIMIT 2`).all(...predicate.params))
      .toEqual([{ path: 'a/visible.md' }, { path: 'b/fallback.md' }]);
    for (const user of [admin, editor, otherEditor, viewer]) {
      const filter = acl.sql(user);
      const rows = database.prepare(`SELECT path FROM acl_test_paths WHERE ${filter.sql} ORDER BY path`).all(...filter.params) as Array<{ path: string }>;
      const expected = user.id === admin.id
        ? ['a/secret.md', 'a/visible.md', 'b/fallback.md', 'wild%_/hidden.md', 'wildXX/visible.md']
        : user.id === editor.id ? ['a/visible.md', 'b/fallback.md', 'wildXX/visible.md'] : ['b/fallback.md', 'wildXX/visible.md'];
      expect(rows.map((row) => row.path)).toEqual(expected);
    }
    expect(() => acl.sql(editor, 'path); DROP TABLE users;--')).toThrow('SQL path column');
  });

  it('enforces admin endpoints and validates safe paths and subject identities', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/admin/acl').expect(401);
    await request(server).get('/api/admin/acl').set('x-user', String(editor.id)).expect(403);
    await request(server).post('/api/admin/acl').set('x-user', String(viewer.id)).send({ prefix: '/', subjectType: 'everyone', access: 'none' }).expect(403);
    for (const prefix of ['', '../', 'notes/../', '/notes/', 'notes\\secret/', '.git/', 'notes/.GiT/config', 'C:/secret/', 'notes//', 'notes/./', 'notes/\u0000']) {
      await request(server).post('/api/admin/acl').set('x-user', String(admin.id)).send({ prefix, subjectType: 'everyone', access: 'none' }).expect(400);
    }
    for (const invalid of [{ subjectType: 'user', subject: 99999 }, { subjectType: 'user', subject: 'email@example.com' }, { subjectType: 'role', subject: 'owner' }, { subjectType: 'everyone', subject: 'other' }]) {
      await request(server).post('/api/admin/acl').set('x-user', String(admin.id)).send({ prefix: '/', access: 'read', ...invalid }).expect(400);
    }
    await request(server).get('/api/admin/acl/check').set('x-user', String(admin.id)).query({ userId: 99999, path: 'notes/one.md' }).expect(404);
    await request(server).get('/api/admin/acl/check').set('x-user', String(admin.id)).query({ userId: viewer.id, path: '../secret.md' }).expect(400);
    await request(server).delete('/api/admin/acl/99999').set('x-user', String(admin.id)).expect(404);
    expect(acl.list()).toEqual([]);
  });

  it('serves live HTTP ACL upserts, explanations, deletion, and one audit event per mutation', async () => {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const headers = { 'x-user': String(admin.id), 'content-type': 'application/json' };
    const created = await fetch(`${base}/api/admin/acl`, { method: 'POST', headers, body: JSON.stringify({ prefix: 'private/', subjectType: 'user', subject: editor.id, access: 'none' }) });
    expect(created.status).toBe(201);
    const first = await created.json() as { rule: { id: number; subject: string } };
    expect(first.rule.subject).toBe(String(editor.id));
    const denied = await fetch(`${base}/api/admin/acl/check?userId=${editor.id}&path=private%2Fone.md`, { headers });
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({ userId: editor.id, path: 'private/one.md', access: 'none', rule: { id: first.rule.id }, reason: 'rule' });
    const updated = await fetch(`${base}/api/admin/acl`, { method: 'POST', headers, body: JSON.stringify({ prefix: 'private/', subjectType: 'user', subject: String(editor.id), access: 'read' }) });
    expect(updated.status).toBe(201);
    expect(await updated.json()).toMatchObject({ rule: { id: first.rule.id, access: 'read' } });
    const listed = await fetch(`${base}/api/admin/acl`, { headers });
    expect(await listed.json()).toMatchObject({ rules: [{ id: first.rule.id, access: 'read' }] });
    const deleted = await fetch(`${base}/api/admin/acl/${first.rule.id}`, { method: 'DELETE', headers });
    expect(deleted.status).toBe(204);
    const fallback = await fetch(`${base}/api/admin/acl/check?userId=${editor.id}&path=private%2Fone.md`, { headers });
    expect(await fallback.json()).toMatchObject({ access: 'write', rule: null, reason: 'role_default' });
    expect(audit.list({ limit: 50 }).events.reverse().map(({ action, actorId, target, outcome }) => ({ action, actorId, target, outcome }))).toEqual([
      { action: 'acl.create', actorId: admin.id, target: `acl:${first.rule.id}`, outcome: 'success' },
      { action: 'acl.update', actorId: admin.id, target: `acl:${first.rule.id}`, outcome: 'success' },
      { action: 'acl.delete', actorId: admin.id, target: `acl:${first.rule.id}`, outcome: 'success' },
    ]);
  });
});
