import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import type { KnowledgeRepo } from '../knowledge/repo.js';
import { NotesService } from './notes.service.js';

const fixtureFiles = ['wiki/Topic.md', 'secret/TOPIC.MD', 'archive/Topic.md', 'wiki/Nested/Unique.md', 'secret/Hidden.md'];

class FixtureRepository implements Pick<KnowledgeRepo, 'listFiles' | 'headSha' | 'readFile'> {
  readonly contents = new Map<string, string>();
  async headSha(): Promise<string> { return 'fixture-sha'; }
  async listFiles(): Promise<string[]> {
    return [...fixtureFiles];
  }
  async readFile(path: string): Promise<string | null> {
    return this.contents.get(path) ?? '# Body';
  }
}

describe('NotesService resolver with authorized repository candidates', () => {
  let db: Db;
  let acl: AclService;
  let notes: NotesService;
  let admin: User;
  let viewer: User;
  let grantedViewer: User;
  let repo: FixtureRepository;

  beforeEach(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    const users = new UsersService(new UsersRepository(db));
    admin = await users.create({ email: 'admin@example.test', role: 'admin' });
    viewer = await users.create({ email: 'viewer@example.test', role: 'viewer' });
    grantedViewer = await users.create({ email: 'granted@example.test', role: 'viewer' });
    acl = new AclService(db, users, new AuditService(db));
    repo = new FixtureRepository();
    notes = new NotesService(repo as unknown as KnowledgeRepo, acl);
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

  it('uses frontmatter aliases as case-insensitive fallbacks without reading hidden notes', async () => {
    repo.contents.set('wiki/Nested/Unique.md', '---\naliases: ["  Knowledge Base  ", "KNOWLEDGE BASE", "번역 이름"]\n---\n# Body');
    repo.contents.set('secret/Hidden.md', '---\naliases: ["Knowledge Base", "Private alias"]\n---\n# Body');
    const read = vi.spyOn(repo, 'readFile');
    expect(await notes.resolve(' knowledge BASE.md#Section|Label', viewer)).toEqual({
      path: 'wiki/Nested/Unique.md', candidates: ['wiki/Nested/Unique.md'],
    });
    expect(await notes.resolve('번역 이름', viewer)).toEqual({
      path: 'wiki/Nested/Unique.md', candidates: ['wiki/Nested/Unique.md'],
    });
    expect(read.mock.calls.every(([path]) => !path.startsWith('secret/'))).toBe(true);
    expect(await notes.resolve('knowledge base', grantedViewer)).toEqual({
      path: null, candidates: ['secret/Hidden.md', 'wiki/Nested/Unique.md'],
    });
    await expect(notes.resolve('Private alias', viewer)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('preserves exact path and basename priority, including ambiguity, over aliases', async () => {
    repo.contents.set('wiki/Nested/Unique.md', '---\naliases: ["Topic", "wiki/Topic"]\n---\n# Body');
    repo.contents.set('archive/Topic.md', '---\naliases: ["Unique"]\n---\n# Body');
    expect(await notes.resolve('topic', viewer)).toEqual({
      path: null, candidates: ['archive/Topic.md', 'wiki/Topic.md'],
    });
    expect(await notes.resolve('WIKI/TOPIC', viewer)).toEqual({
      path: 'wiki/Topic.md', candidates: ['wiki/Topic.md'],
    });
    expect(await notes.resolve('unique', viewer)).toEqual({
      path: 'wiki/Nested/Unique.md', candidates: ['wiki/Nested/Unique.md'],
    });
  });

  it('uses visible alias fallback after filtering inaccessible exact matches', async () => {
    repo.contents.set('wiki/Nested/Unique.md', '---\naliases: ["Hidden", "secret/Hidden"]\n---\n# Body');
    for (const target of ['Hidden', 'SECRET/HIDDEN.MD#Section']) {
      expect(await notes.resolve(target, viewer)).toEqual({
        path: 'wiki/Nested/Unique.md', candidates: ['wiki/Nested/Unique.md'],
      });
      expect(await notes.resolve(target, grantedViewer)).toEqual({
        path: 'secret/Hidden.md', candidates: ['secret/Hidden.md'],
      });
    }
  });

  it('does not resolve invalid alias fields or blank aliases', async () => {
    repo.contents.set('wiki/Topic.md', '---\naliases: "scalar alias"\n---\n# Body');
    repo.contents.set('archive/Topic.md', '---\naliases: ["mixed alias", 42]\n---\n# Body');
    repo.contents.set('wiki/Nested/Unique.md', '---\naliases: [" ", ""]\n---\n# Body');
    for (const target of ['scalar alias', 'mixed alias', ' #Section']) {
      await expect(notes.resolve(target, viewer)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    }
  });

  it('rechecks ACL after asynchronous alias reads before returning candidates', async () => {
    repo.contents.set('wiki/Nested/Unique.md', '---\naliases: ["Unique alias"]\n---\n# Body');
    const read = repo.readFile.bind(repo);
    vi.spyOn(repo, 'readFile').mockImplementation(async (path) => {
      const content = await read(path);
      if (path === 'wiki/Nested/Unique.md') {
        acl.create({ prefix: 'wiki/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
      }
      return content;
    });
    await expect(notes.resolve('Unique alias', viewer)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
