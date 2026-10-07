import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AclService, type AclUser } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../auth/users.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { CatalogService } from './catalog.service.js';

const viewer: AclUser = { id: 7, role: 'viewer' };
let db: Db;
let catalog: CatalogService;
function note(path: string) {
  db.prepare(`INSERT INTO chunks(path,title,heading,content,embedding_text,content_hash,kind,ordinal)
    VALUES(?,?,'','body','body',?,'wiki',0)`).run(path, path, path);
}
function link(source: string, key: string, text: string, target: string | null) {
  db.prepare('INSERT INTO links(source_path,target_name,target_text,target_path) VALUES(?,?,?,?)').run(source, key, text, target);
}
beforeEach(() => {
  db = openDb(':memory:'); runMigrations(db);
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
  catalog = new CatalogService(db, acl);
  note('wiki/source.md'); note('public/Shared.md'); note('secret/Shared.md'); note('secret/Private.md');
  db.prepare(`INSERT INTO acl_rules(prefix,subject_type,subject,access,created_by,created_at)
    VALUES('secret/','everyone','','none',1,'2026-10-07T00:00:00Z')`).run();
});
afterEach(() => db.close());

describe('reader-visible link resolution', () => {
  it('preserves unresolved target spelling and folder while omitting hidden resolved targets', () => {
    link('wiki/source.md', 'archive/newdraft', 'Archive/NewDraft.MD', null);
    link('wiki/source.md', 'secret/private', 'secret/Private', 'secret/Private.md');
    expect(catalog.links('wiki/source.md', viewer)).toEqual({ outgoing: [], backlinks: [], unresolved: ['Archive/NewDraft.MD'] });
    expect(catalog.graph('wiki/source.md', 1, viewer).edges).toEqual([]);
  });

  it('uses the same visible unique candidate for outgoing links, backlinks and graph', () => {
    // The index cannot resolve globally duplicated basenames. A reader has one visible candidate.
    link('wiki/source.md', 'shared', 'Shared', null);
    expect(catalog.links('wiki/source.md', viewer)).toEqual({ outgoing: [{ path: 'public/Shared.md', title: 'public/Shared.md' }], backlinks: [], unresolved: [] });
    expect(catalog.links('public/Shared.md', viewer).backlinks).toEqual([{ path: 'wiki/source.md', title: 'wiki/source.md' }]);
    expect(catalog.graph('wiki/source.md', 1, viewer)).toEqual({ nodes: [
      { path: 'public/Shared.md', title: 'public/Shared.md', tags: [] },
      { path: 'wiki/source.md', title: 'wiki/source.md', tags: [] },
    ], edges: [{ from: 'wiki/source.md', to: 'public/Shared.md' }] });
    expect(catalog.links('wiki/source.md').unresolved).toEqual(['Shared']);
    expect(catalog.graph().edges).toEqual([]);
  });

  it('changes ambiguity with the current ACL without exposing hidden candidates', () => {
    link('wiki/source.md', 'shared', 'Shared', null);
    expect(catalog.links('wiki/source.md', viewer).outgoing.map((hit) => hit.path)).toEqual(['public/Shared.md']);
    db.prepare('DELETE FROM acl_rules').run();
    expect(catalog.links('wiki/source.md', viewer)).toEqual({ outgoing: [], backlinks: [], unresolved: ['Shared'] });
    expect(catalog.graph('wiki/source.md', 5, viewer).edges).toEqual([]);
  });

  it('never reconstructs backlinks from hidden source notes', () => {
    link('secret/Shared.md', 'public/shared', 'public/Shared', 'public/Shared.md');
    expect(catalog.links('public/Shared.md', viewer)).toEqual({ outgoing: [], backlinks: [], unresolved: [] });
    expect(catalog.graph(undefined, 1, viewer).edges).toEqual([]);
  });
});
