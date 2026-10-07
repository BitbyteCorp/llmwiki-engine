import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import type { KnowledgeRepo } from '../knowledge/repo.js';
import { NotesService } from './notes.service.js';

const fixtureFiles = ['wiki/Topic.md', 'secret/TOPIC.MD', 'archive/Topic.md', 'wiki/Nested/Unique.md', 'secret/Hidden.md'];

class FixtureRepository implements Pick<KnowledgeRepo, 'listFiles'> {
  async listFiles(): Promise<string[]> {
    return [...fixtureFiles];
  }
}

describe('NotesService resolver with authorized repository candidates', () => {
  let db: Db;
  let acl: AclService;
  let notes: NotesService;
  let admin: User;
  let viewer: User;
  let grantedViewer: User;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    const users = new UsersService(new UsersRepository(db));
    admin = users.create({ email: 'admin@example.test', role: 'admin' });
    viewer = users.create({ email: 'viewer@example.test', role: 'viewer' });
    grantedViewer = users.create({ email: 'granted@example.test', role: 'viewer' });
    acl = new AclService(db, users, new AuditService(db));
    notes = new NotesService(new FixtureRepository() as KnowledgeRepo, acl);
    acl.create({ prefix: 'secret/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    acl.create({ prefix: 'secret/', subjectType: 'user', subject: String(grantedViewer.id), access: 'read' }, admin);
  });

  afterEach(() => { if (db?.open) db.close(); });

  it('keeps a bare duplicate ambiguous without leaking hidden candidates', async () => {
    expect(await notes.resolve('  TOPIC.md  |Display label', viewer)).toEqual({
      path: null, candidates: ['archive/Topic.md', 'wiki/Topic.md'],
    });
    expect(await notes.resolve('Topic', grantedViewer)).toEqual({
      path: null, candidates: ['archive/Topic.md', 'secret/TOPIC.MD', 'wiki/Topic.md'],
    });
  });

  it('resolves qualified mixed-case targets with suffix, whitespace and fragment', async () => {
    expect(await notes.resolve('  WIKI/ToPiC.MD  #Overview|Label', viewer)).toEqual({
      path: 'wiki/Topic.md', candidates: ['wiki/Topic.md'],
    });
    expect(await notes.resolve('  unique  ', viewer)).toEqual({
      path: 'wiki/Nested/Unique.md', candidates: ['wiki/Nested/Unique.md'],
    });
  });

  it('treats hidden basename and qualified targets exactly like missing notes', async () => {
    for (const target of ['Missing', 'Wrong/Topic', 'Hidden', 'secret/Hidden.md', 'SECRET/TOPIC.MD#Overview']) {
      await expect(notes.resolve(target, viewer)).rejects.toMatchObject({
        status: 404, code: 'not_found', message: 'Note not found',
      });
    }
  });

  it('resolves the only authorized candidate even when an inaccessible basename duplicates it', async () => {
    acl.create({ prefix: 'archive/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    expect(await notes.resolve('Topic', viewer)).toEqual({
      path: 'wiki/Topic.md', candidates: ['wiki/Topic.md'],
    });
  });

  it('applies current ACL grants on each resolution and preserves administrator access', async () => {
    expect(await notes.resolve('secret/hidden.MD|Label', grantedViewer)).toEqual({
      path: 'secret/Hidden.md', candidates: ['secret/Hidden.md'],
    });
    acl.create({ prefix: 'secret/', subjectType: 'user', subject: String(grantedViewer.id), access: 'none' }, admin);
    await expect(notes.resolve('Hidden', grantedViewer)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(await notes.resolve('secret/Hidden', admin)).toEqual({
      path: 'secret/Hidden.md', candidates: ['secret/Hidden.md'],
    });
  });
});
