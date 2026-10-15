import { setImmediate } from 'node:timers/promises';
import { HttpException } from '@nestjs/common';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { AclService, type AclUser } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../auth/users.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { ComparisonService } from './comparison.service.js';

let db: Db;
let config: Config;
let comparison: ComparisonService;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
  config = loadConfig({ NODE_ENV: 'test', EMBEDDING_MODEL: 'fixture-model', EMBEDDING_DIMENSIONS: '2' });
  comparison = new ComparisonService(config, db, pino({ level: 'silent' }),
    new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db)));
});

afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
});

function addChunk(path: string, options: {
  hash?: string; ordinal?: number; anchor?: string | null; content?: string;
  vector?: number[]; pending?: boolean; cacheModel?: string;
} = {}): void {
  const ordinal = options.ordinal ?? 0;
  const contentHash = `${path}:${ordinal}`;
  const row = db.prepare(`INSERT INTO chunks
    (path,title,heading,content,embedding_text,content_hash,kind,ordinal,anchor,normalized_hash,vector_pending)
    VALUES (?,?,?,?,?,?,'wiki',?,?,?,?)`).run(
    path, path.replace(/^wiki\//, '').replace(/\.md$/, ''), '', options.content ?? `Text from ${path}`,
    'fixture input', contentHash, ordinal, options.anchor ?? null, options.hash ?? `note:${path}`,
    options.vector && !options.pending ? 0 : 1,
  );
  if (options.vector) {
    const bytes = Buffer.from(new Float32Array(options.vector).buffer);
    db.prepare('INSERT INTO embedding_cache(content_hash,model,dimensions,embedding) VALUES (?,?,?,?)')
      .run(contentHash, options.cacheModel ?? config.embeddingModel, options.vector.length, bytes);
    db.prepare('INSERT INTO chunk_vectors(chunk_id,embedding) VALUES (?,?)').run(BigInt(row.lastInsertRowid), bytes);
  }
}

function configureVectors(): void {
  db.exec(`CREATE VIRTUAL TABLE chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${config.embeddingDimensions}])`);
  const set = db.prepare('INSERT INTO index_meta(key,value) VALUES (?,?)');
  set.run('embedding_model', config.embeddingModel);
  set.run('embedding_dimensions', String(config.embeddingDimensions));
}

describe('note comparison', () => {
  it('retains exact normalized-note duplicates without embeddings, once per note pair', async () => {
    addChunk('wiki/c.md', { hash: 'same-normalized-note', content: 'Same body.' });
    addChunk('wiki/a.md', { hash: 'same-normalized-note', content: 'Same body.' });
    addChunk('wiki/a.md', { hash: 'same-normalized-note', ordinal: 1, content: 'Extra indexed section.' });
    addChunk('wiki/b.md', { hash: 'same-normalized-note', content: ' Same\nbody. ' });
    addChunk('wiki/d.md', { hash: 'different-whole-note', content: 'Same body.' });

    db.pragma('query_only = ON');
    expect(await comparison.duplicates()).toEqual([
      { left: { path: 'wiki/a.md', title: 'a' }, right: { path: 'wiki/b.md', title: 'b' }, score: 1, reason: 'exact',
        passages: [{ left: { anchor: null, excerpt: 'Same body.' }, right: { anchor: null, excerpt: 'Same body.' } }] },
      { left: { path: 'wiki/a.md', title: 'a' }, right: { path: 'wiki/c.md', title: 'c' }, score: 1, reason: 'exact',
        passages: [{ left: { anchor: null, excerpt: 'Same body.' }, right: { anchor: null, excerpt: 'Same body.' } }] },
      { left: { path: 'wiki/b.md', title: 'b' }, right: { path: 'wiki/c.md', title: 'c' }, score: 1, reason: 'exact',
        passages: [{ left: { anchor: null, excerpt: 'Same body.' }, right: { anchor: null, excerpt: 'Same body.' } }] },
    ]);
    expect(await comparison.duplicates(1)).toEqual([(await comparison.duplicates())[0]]);
  });

  it('scopes exact and semantic pairs before loading vectors while preserving the unscoped default', async () => {
    configureVectors();
    addChunk('wiki/a.md', { hash: 'same', vector: [1, 0] });
    addChunk('wiki/b.md', { hash: 'same', vector: [1, 0] });
    addChunk('wiki/c.md', { vector: [1, 0] });
    addChunk('raw/a.md', { hash: 'same', vector: [0, 1] });
    addChunk('raw/b.md', { hash: 'same', vector: [0, 1] });
    addChunk('raw/c.md', { vector: [0, 1] });
    const reads = vi.spyOn(Buffer.prototype, 'readFloatLE');
    const scoped = await comparison.duplicates(20, undefined, { pathPrefixes: ['wiki/'] });
    expect(scoped.map(({ left, right, reason }) => [left.path, right.path, reason])).toEqual([
      ['wiki/a.md', 'wiki/b.md', 'exact'],
      ['wiki/a.md', 'wiki/c.md', 'semantic'],
      ['wiki/b.md', 'wiki/c.md', 'semantic'],
    ]);
    const wikiVector = Buffer.from(new Float32Array([1, 0]).buffer);
    expect(reads).toHaveBeenCalled();
    expect(reads.mock.contexts.every((bytes) => bytes.equals(wikiVector))).toBe(true);
    reads.mockClear();
    expect(await comparison.duplicates(20, undefined, { pathPrefixes: [] })).toEqual([]);
    expect(reads).not.toHaveBeenCalled();

    reads.mockClear();
    expect(await comparison.similar('wiki/a.md')).toHaveLength(5);
    const rawVector = Buffer.from(new Float32Array([0, 1]).buffer);
    expect(reads).toHaveBeenCalled();
    expect(reads.mock.contexts.every((bytes) => bytes.equals(rawVector))).toBe(true);
    reads.mockClear();
    expect(await comparison.similar('wiki/a.md')).toHaveLength(5);
    expect(await comparison.similar('raw/a.md')).toHaveLength(5);
    expect(reads).not.toHaveBeenCalled();
    expect(await comparison.duplicates(20, undefined, { pathPrefixes: ['wiki/'] })).toEqual(scoped);
    const unscoped = await comparison.duplicates();
    expect(unscoped.filter(({ left, right }) => left.path.startsWith('wiki/') && right.path.startsWith('wiki/'))).toEqual(scoped);
    expect(unscoped).toContainEqual(expect.objectContaining({
      left: { path: 'raw/a.md', title: 'raw/a' }, right: { path: 'raw/c.md', title: 'raw/c' }, reason: 'semantic',
    }));
    expect(unscoped).toContainEqual(expect.objectContaining({
      left: { path: 'raw/a.md', title: 'raw/a' }, right: { path: 'wiki/a.md', title: 'a' }, reason: 'exact',
    }));
  });

  it('combines literal path prefixes without SQL wildcard expansion', async () => {
    for (const path of ['wiki_/a.md', 'wiki_/b.md', 'other%/a.md', 'other%/b.md', 'wikix/a.md']) {
      addChunk(path, { hash: 'same' });
    }
    const pairs = await comparison.duplicates(20, undefined, { pathPrefixes: ['wiki_/', 'other%/'] });
    expect(pairs).toHaveLength(6);
    expect(pairs.every(({ left, right }) => left.path !== 'wikix/a.md' && right.path !== 'wikix/a.md')).toBe(true);
  });

  it.each(['exact', 'semantic'] as const)('yields during %s pair comparisons without changing scores, passages or ordering', async (reason) => {
    config.embeddingDimensions = 1536;
    configureVectors();
    const vector = Array.from({ length: config.embeddingDimensions }, (_, index) => index === 0 ? 1 : 0);
    for (let index = 0; index < 50; index++) {
      addChunk(`wiki/${String(index).padStart(2, '0')}.md`, {
        hash: reason === 'exact' ? 'same' : `different:${index}`, vector,
        anchor: `section-${index}`, content: `Passage ${index}.`,
      });
    }
    let finished = false;
    let progress = 0;
    const tick = setImmediate().then(() => {
      expect(finished).toBe(false);
      progress++;
    });
    const pending = comparison.duplicates().then((pairs) => {
      finished = true;
      return pairs;
    });
    const [pairs] = await Promise.all([pending, tick]);
    expect(progress).toBe(1);
    expect(pairs).toEqual(Array.from({ length: 20 }, (_, offset) => {
      const index = offset + 1;
      const name = String(index).padStart(2, '0');
      return {
        left: { path: 'wiki/00.md', title: '00' }, right: { path: `wiki/${name}.md`, title: name },
        score: 1, reason, passages: [{
          left: { anchor: 'section-0', excerpt: 'Passage 0.' },
          right: { anchor: `section-${index}`, excerpt: `Passage ${index}.` },
        }],
      };
    }));
  });

  it.each(['exact', 'semantic'] as const)('rejects stale ACL results when policy changes while yielding in %s comparisons', async (reason) => {
    configureVectors();
    for (let index = 0; index < 50; index++) {
      addChunk(`wiki/${index}.md`, { hash: reason === 'exact' ? 'same' : `different:${index}`, vector: [1, 0] });
    }
    const user: AclUser = { id: 1, role: 'viewer' };
    const changed = setImmediate().then(() => db.prepare('UPDATE acl_policy SET revision = revision + 1 WHERE id = 1').run());
    const pending = comparison.duplicates(20, user);
    await expect(pending).rejects.toThrow('Search policy changed; retry the query');
    await changed;
  });

  it('rejects stale duplicate results when the current user role changes across a yield', async () => {
    for (let index = 0; index < 50; index++) addChunk(`wiki/${index}.md`, { hash: 'same' });
    const user: AclUser = { id: 1, role: 'viewer' };
    const changed = setImmediate().then(() => { user.role = 'editor'; });
    const pending = comparison.duplicates(20, user);
    await expect(pending).rejects.toThrow('Search policy changed; retry the query');
    await changed;
  });

  it.each(['similar', 'duplicates'] as const)('shares normalized vectors across repeated comparisons after cold %s', async (first) => {
    configureVectors();
    for (const path of ['wiki/a.md', 'wiki/b.md', 'wiki/c.md']) {
      addChunk(path, { hash: 'same', vector: [1, 0] });
    }
    const reads = vi.spyOn(Buffer.prototype, 'readFloatLE');
    if (first === 'similar') await comparison.similar('wiki/a.md');
    else await comparison.duplicates();
    expect(reads).toHaveBeenCalled();
    reads.mockClear();

    for (let index = 0; index < 3; index++) {
      expect(await comparison.similar('wiki/a.md')).toEqual([
        { path: 'wiki/b.md', title: 'b', score: 1 }, { path: 'wiki/c.md', title: 'c', score: 1 },
      ]);
      expect((await comparison.duplicates()).map(({ left, right, reason }) => [left.path, right.path, reason])).toEqual([
        ['wiki/a.md', 'wiki/b.md', 'exact'], ['wiki/a.md', 'wiki/c.md', 'exact'], ['wiki/b.md', 'wiki/c.md', 'exact'],
      ]);
    }
    expect(reads).not.toHaveBeenCalled();
  });

  it('loads only surviving semantic passage vectors without rebuilding warm means or exposing cached objects', async () => {
    configureVectors();
    for (let index = 0; index < 70; index++) {
      addChunk(`wiki/${String(index).padStart(3, '0')}.md`, {
        vector: [1, 0], anchor: `section-${index}`, content: `Passage ${index}.`,
      });
    }
    const reads = vi.spyOn(Buffer.prototype, 'readFloatLE');
    const hits = await comparison.similar('wiki/000.md', 1);
    const buildReads = reads.mock.calls.length;
    reads.mockClear();
    const pairs = await comparison.duplicates(1);
    const passageReads = reads.mock.calls.length;
    expect(passageReads).toBeGreaterThan(0);
    expect(passageReads).toBeLessThan(buildReads);
    expect(pairs).toEqual([{
      left: { path: 'wiki/000.md', title: '000' }, right: { path: 'wiki/001.md', title: '001' }, score: 1, reason: 'semantic',
      passages: [{ left: { anchor: 'section-0', excerpt: 'Passage 0.' }, right: { anchor: 'section-1', excerpt: 'Passage 1.' } }],
    }]);
    hits[0]!.title = 'mutated';
    hits[0]!.score = -1;
    pairs[0]!.left.path = 'wiki/mutated.md';
    pairs[0]!.passages[0]!.left.excerpt = 'mutated';
    reads.mockClear();
    expect(await comparison.similar('wiki/000.md', 1)).toEqual([{ path: 'wiki/001.md', title: '001', score: 1 }]);
    expect(reads).not.toHaveBeenCalled();
    const repeated = await comparison.duplicates(1);
    expect(repeated[0]!.left.path).toBe('wiki/000.md');
    expect(repeated[0]!.passages[0]!.left.excerpt).toBe('Passage 0.');
    expect(reads.mock.calls.length).toBeLessThanOrEqual(passageReads);
  });

  it('single-flights concurrent similar and duplicate builds', async () => {
    configureVectors();
    for (let index = 0; index < 130; index++) {
      addChunk(`wiki/${String(index).padStart(3, '0')}.md`, { hash: 'same', vector: [1, 0] });
    }
    const reads = vi.spyOn(Buffer.prototype, 'readFloatLE');
    const expected = await comparison.similar('wiki/000.md', 1);
    const buildReads = reads.mock.calls.length;
    db.prepare("INSERT INTO index_meta(key,value) VALUES('indexed_sha','next')").run();
    reads.mockClear();

    const [left, pairs, right] = await Promise.all([
      comparison.similar('wiki/000.md', 1), comparison.duplicates(1), comparison.similar('wiki/000.md', 1),
    ]);
    expect(left).toEqual(expected);
    expect(right).toEqual(expected);
    expect(pairs[0]).toMatchObject({ left: { path: 'wiki/000.md' }, right: { path: 'wiki/001.md' }, reason: 'exact' });
    expect(reads).toHaveBeenCalledTimes(buildReads);
  });

  it.each(['indexed_sha', 'catalog_revision', 'total_changes'] as const)('invalidates vectors with %s, including rebuilds at the same SHA', async (generation) => {
    configureVectors();
    addChunk('wiki/a.md', { vector: [1, 0] });
    addChunk('wiki/b.md', { vector: [1, 0] });
    db.prepare("INSERT INTO index_meta(key,value) VALUES('indexed_sha','same-sha')").run();
    if (generation !== 'total_changes') db.prepare("INSERT INTO index_meta(key,value) VALUES('catalog_revision','1')").run();
    expect(await comparison.similar('wiki/a.md')).toEqual([{ path: 'wiki/b.md', title: 'b', score: 1 }]);
    expect((await comparison.duplicates())[0]!.reason).toBe('semantic');

    db.prepare('UPDATE embedding_cache SET embedding = ? WHERE content_hash = ?')
      .run(Buffer.from(new Float32Array([0, 1]).buffer), 'wiki/b.md:0');
    db.prepare("UPDATE chunks SET title = 'New title' WHERE path = 'wiki/b.md'").run();
    if (generation !== 'total_changes') {
      db.prepare('UPDATE index_meta SET value = ? WHERE key = ?')
        .run(generation === 'indexed_sha' ? 'new-sha' : '2', generation);
    }
    const reads = vi.spyOn(Buffer.prototype, 'readFloatLE');
    expect(await comparison.similar('wiki/a.md')).toEqual([{ path: 'wiki/b.md', title: 'New title', score: 0 }]);
    expect(reads).toHaveBeenCalled();
    reads.mockClear();
    expect(await comparison.duplicates()).toEqual([]);
    expect(await comparison.similar('wiki/a.md')).toEqual([{ path: 'wiki/b.md', title: 'New title', score: 0 }]);
    expect(reads).not.toHaveBeenCalled();
  });

  it('projects the current ACL over a shared pre-ACL cache without rebuilding for policy writes', async () => {
    configureVectors();
    db.prepare("INSERT INTO index_meta(key,value) VALUES('catalog_revision','1')").run();
    for (const path of ['wiki/source.md', 'wiki/public.md', 'wiki/secret.md']) {
      addChunk(path, { hash: 'same', vector: [1, 0] });
    }
    db.prepare(`INSERT INTO acl_rules(prefix,subject_type,subject,access,created_by,created_at)
      VALUES('wiki/secret.md','role','viewer','none',1,'fixture')`).run();
    const viewer: AclUser = { id: 1, role: 'viewer' };
    const admin: AclUser = { id: 2, role: 'admin' };
    expect(await comparison.similar('wiki/source.md', 20, viewer)).toEqual([{ path: 'wiki/public.md', title: 'public', score: 1 }]);
    const reads = vi.spyOn(Buffer.prototype, 'readFloatLE');
    expect((await comparison.similar('wiki/source.md', 20, admin)).map(({ path }) => path)).toEqual(['wiki/public.md', 'wiki/secret.md']);
    expect(await comparison.duplicates(20, viewer)).toHaveLength(1);
    expect(await comparison.duplicates(20, admin)).toHaveLength(3);
    db.prepare("UPDATE acl_rules SET access = 'read' WHERE prefix = 'wiki/secret.md'").run();
    expect(await comparison.duplicates(20, viewer)).toHaveLength(3);
    db.prepare("UPDATE acl_rules SET access = 'none' WHERE prefix = 'wiki/secret.md'").run();
    expect((await comparison.similar('wiki/source.md', 20, viewer)).map(({ path }) => path)).toEqual(['wiki/public.md']);
    const denied = await comparison.similar('wiki/secret.md', 20, viewer).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(HttpException);
    expect((denied as HttpException).getStatus()).toBe(404);
    expect((denied as HttpException).getResponse()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(['model', 'dimensions', 'stored_model', 'stored_dimensions', 'mismatch'] as const)('checks %s compatibility even after warming vectors', async (change) => {
    configureVectors();
    db.prepare("INSERT INTO index_meta(key,value) VALUES('catalog_revision','1')").run();
    addChunk('wiki/a.md', { hash: 'same', vector: [1, 0] });
    addChunk('wiki/b.md', { hash: 'same', vector: [1, 0] });
    expect(await comparison.similar('wiki/a.md')).toHaveLength(1);
    if (change === 'model') config.embeddingModel = 'other-model';
    else if (change === 'dimensions') config.embeddingDimensions = 3;
    else if (change === 'mismatch') db.prepare("INSERT INTO index_meta(key,value) VALUES('vector_mismatch','1')").run();
    else db.prepare('UPDATE index_meta SET value = ? WHERE key = ?')
      .run('different', change === 'stored_model' ? 'embedding_model' : 'embedding_dimensions');
    expect(await comparison.similar('wiki/a.md')).toEqual([]);
    expect((await comparison.duplicates())[0]).toMatchObject({ reason: 'exact', score: 1 });
  });

  it('yields while cold-building rows even when there are too few notes to yield in scoring', async () => {
    configureVectors();
    for (let ordinal = 64; ordinal >= 0; ordinal--) {
      addChunk('wiki/source.md', { ordinal, vector: ordinal === 0 ? [2 ** 60, 0] : ordinal === 1 ? [-(2 ** 60), 0] : ordinal === 64 ? [1, 1] : [0, 1] });
    }
    addChunk('wiki/match.md', { vector: [1, 63] });
    addChunk('wiki/vertical.md', { vector: [0, 1] });
    let finished = false;
    const tick = setImmediate().then(() => { expect(finished).toBe(false); });
    const pending = comparison.similar('wiki/source.md').then((hits) => { finished = true; return hits; });
    const [hits] = await Promise.all([pending, tick]);
    expect(hits.map(({ path }) => path)).toEqual(['wiki/match.md', 'wiki/vertical.md']);
    expect(hits[0]!.score).toBeCloseTo(1, 12);
    expect(hits[1]!.score).toBeCloseTo(0.9998740474835989, 12);
  });

  it.each(['indexed_sha', 'catalog_revision', 'total_changes'] as const)('discards an in-flight build when %s changes across a row-batch yield', async (generation) => {
    configureVectors();
    db.prepare("INSERT INTO index_meta(key,value) VALUES('indexed_sha','same-sha')").run();
    if (generation !== 'total_changes') db.prepare("INSERT INTO index_meta(key,value) VALUES('catalog_revision','1')").run();
    for (let index = 0; index < 130; index++) {
      addChunk(`wiki/${String(index).padStart(3, '0')}.md`, { vector: [1, 0] });
    }
    const changed = setImmediate().then(() => db.transaction(() => {
      db.prepare("UPDATE embedding_cache SET embedding = ? WHERE content_hash <> 'wiki/000.md:0'")
        .run(Buffer.from(new Float32Array([0, 1]).buffer));
      db.prepare("UPDATE chunks SET title = 'Current' WHERE path <> 'wiki/000.md'").run();
      if (generation !== 'total_changes') {
        db.prepare('UPDATE index_meta SET value = ? WHERE key = ?').run(generation === 'indexed_sha' ? 'next-sha' : '2', generation);
      }
    })());
    const pending = comparison.similar('wiki/000.md', 1);
    const [hits] = await Promise.all([pending, changed]);
    expect(hits).toEqual([{ path: 'wiki/001.md', title: 'Current', score: 0 }]);
    expect(await comparison.similar('wiki/000.md', 1)).toEqual(hits);
  });

  it('yields in large warm similar scoring without changing scores or path ordering', async () => {
    config.embeddingDimensions = 1536;
    configureVectors();
    const vector = Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0);
    for (let index = 0; index < 258; index++) {
      addChunk(`wiki/${String(index).padStart(3, '0')}.md`, { vector });
    }
    await comparison.similar('wiki/000.md');
    let finished = false;
    const tick = setImmediate().then(() => { expect(finished).toBe(false); });
    const pending = comparison.similar('wiki/000.md').then((hits) => { finished = true; return hits; });
    const [hits] = await Promise.all([pending, tick]);
    expect(hits).toEqual(Array.from({ length: 20 }, (_, index) => {
      const name = String(index + 1).padStart(3, '0');
      return { path: `wiki/${name}.md`, title: name, score: 1 };
    }));
  });

  it.each(['similar', 'duplicates'] as const)('rejects %s when ACL changes during a cold cache build', async (operation) => {
    configureVectors();
    for (let index = 0; index < 130; index++) {
      addChunk(`wiki/${String(index).padStart(3, '0')}.md`, { vector: [1, 0] });
    }
    const user: AclUser = { id: 1, role: 'viewer' };
    const changed = setImmediate().then(() => db.prepare('UPDATE acl_policy SET revision = revision + 1 WHERE id = 1').run());
    const pending = operation === 'similar' ? comparison.similar('wiki/000.md', 20, user) : comparison.duplicates(20, user);
    await expect(pending).rejects.toThrow('Search policy changed; retry the query');
    await changed;
  });

  it.each(['revision', 'role'] as const)('rejects warm similar results when the policy %s changes across a scoring yield', async (change) => {
    configureVectors();
    for (let index = 0; index < 258; index++) {
      addChunk(`wiki/${String(index).padStart(3, '0')}.md`, { vector: [1, 0] });
    }
    await comparison.similar('wiki/000.md');
    const user: AclUser = { id: 1, role: 'viewer' };
    const changed = setImmediate().then(() => {
      if (change === 'revision') db.prepare('UPDATE acl_policy SET revision = revision + 1 WHERE id = 1').run();
      else user.role = 'editor';
    });
    await expect(comparison.similar('wiki/000.md', 20, user)).rejects.toThrow('Search policy changed; retry the query');
    await changed;
  });

  it('does not substitute linked neighbors when semantic vectors are unavailable', async () => {
    addChunk('wiki/source.md');
    addChunk('wiki/linked.md');
    db.prepare('INSERT INTO links(source_path,target_name,target_path) VALUES (?,?,?)')
      .run('wiki/source.md', 'linked', 'wiki/linked.md');

    expect(await comparison.similar('wiki/source.md')).toEqual([]);
  });

  it('ranks unlinked semantic neighbors by the normalized mean of every ready chunk', async () => {
    configureVectors();
    addChunk('wiki/source.md', { vector: [1, 0] });
    addChunk('wiki/source.md', { vector: [0, 1], ordinal: 1 });
    addChunk('wiki/unlinked.md', { vector: [1, 0] });
    addChunk('wiki/unlinked.md', { vector: [0, 1], ordinal: 1 });
    addChunk('wiki/linked.md', { vector: [1, 0] });
    addChunk('wiki/pending.md', { vector: [1, 1], pending: true });
    addChunk('wiki/old-model.md', { vector: [1, 1], cacheModel: 'old-model' });
    db.prepare('INSERT INTO links(source_path,target_name,target_path) VALUES (?,?,?)')
      .run('wiki/source.md', 'linked', 'wiki/linked.md');

    db.pragma('query_only = ON');
    const hits = await comparison.similar('wiki/source.md');
    expect(hits.map(({ path }) => path)).toEqual(['wiki/unlinked.md', 'wiki/linked.md']);
    expect(hits[0]!.score).toBeCloseTo(1, 12);
    expect(hits[1]!.score).toBeCloseTo(0.7071067811865476, 12);
    expect(await comparison.similar('wiki/source.md', 1)).toEqual([hits[0]]);
    expect(await comparison.similar('wiki/missing.md')).toEqual([]);
  });

  it('reports semantic duplicates with the best matched chunk anchors and bounded excerpts', async () => {
    configureVectors();
    addChunk('wiki/a.md', { vector: [1, 0], anchor: 'first', content: 'The first idea.' });
    addChunk('wiki/a.md', { vector: [0, 1], ordinal: 1, anchor: 'second', content: 'The second idea.' });
    addChunk('wiki/b.md', { vector: [0, 1], anchor: 'different', content: 'Another second idea.' });
    addChunk('wiki/b.md', { vector: [1, 0], ordinal: 1, anchor: 'match', content: 'x'.repeat(300) });
    addChunk('wiki/unrelated.md', { vector: [1, 0] });

    db.pragma('query_only = ON');
    const pairs = await comparison.duplicates();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      left: { path: 'wiki/a.md', title: 'a' }, right: { path: 'wiki/b.md', title: 'b' }, reason: 'semantic',
      passages: [{ left: { anchor: 'first', excerpt: 'The first idea.' },
        right: { anchor: 'match', excerpt: 'x'.repeat(240) } }],
    });
    expect(pairs[0]!.score).toBeCloseTo(1, 12);
  });

  it('requires a very high note cosine rather than any merely related pair', async () => {
    configureVectors();
    addChunk('wiki/a.md', { vector: [1, 0] });
    addChunk('wiki/b.md', { vector: [0.99, 0.1] });
    addChunk('wiki/related.md', { vector: [0.9, 0.4358899] });

    const pairs = await comparison.duplicates();
    expect(pairs.map(({ left, right, reason }) => [left.path, right.path, reason]))
      .toEqual([['wiki/a.md', 'wiki/b.md', 'semantic']]);
    expect(pairs[0]!.score).toBeCloseTo(0.994937189022498, 6);
  });

  it.each(['embedding_model', 'embedding_dimensions'])('disables semantic comparisons on mismatched %s without losing exact matches', async (key) => {
    configureVectors();
    addChunk('wiki/a.md', { vector: [1, 0], hash: 'equal' });
    addChunk('wiki/b.md', { vector: [1, 0], hash: 'equal' });
    db.prepare('UPDATE index_meta SET value = ? WHERE key = ?').run('mismatch', key);

    expect(await comparison.similar('wiki/a.md')).toEqual([]);
    expect((await comparison.duplicates()).map(({ left, right, score, reason }) => [left.path, right.path, score, reason]))
      .toEqual([['wiki/a.md', 'wiki/b.md', 1, 'exact']]);
  });

  it('blocks stale vectors until a flagged rebuild succeeds without hiding exact duplicates', async () => {
    configureVectors();
    addChunk('wiki/a.md', { vector: [1, 0], hash: 'equal' });
    addChunk('wiki/b.md', { vector: [1, 0], hash: 'equal' });
    addChunk('wiki/semantic.md', { vector: [1, 0] });
    db.prepare('INSERT INTO index_meta(key,value) VALUES (?,?)').run('vector_mismatch', '1');

    expect(await comparison.similar('wiki/a.md')).toEqual([]);
    expect((await comparison.duplicates()).map(({ left, right, score, reason }) => [left.path, right.path, score, reason]))
      .toEqual([['wiki/a.md', 'wiki/b.md', 1, 'exact']]);

    db.prepare('UPDATE index_meta SET value = ? WHERE key = ?').run('0', 'vector_mismatch');
    expect(await comparison.similar('wiki/a.md')).toEqual([
      { path: 'wiki/b.md', title: 'b', score: 1 }, { path: 'wiki/semantic.md', title: 'semantic', score: 1 },
    ]);
  });

  it('sorts equal semantic scores by path and gives exact duplicates precedence over semantic labeling', async () => {
    configureVectors();
    addChunk('wiki/c.md', { vector: [1, 0] });
    addChunk('wiki/a.md', { vector: [1, 0], hash: 'equal' });
    addChunk('wiki/b.md', { vector: [1, 0], hash: 'equal' });

    expect(await comparison.similar('wiki/c.md')).toEqual([
      { path: 'wiki/a.md', title: 'a', score: 1 }, { path: 'wiki/b.md', title: 'b', score: 1 },
    ]);
    expect((await comparison.duplicates()).map(({ left, right, reason }) => [left.path, right.path, reason])).toEqual([
      ['wiki/a.md', 'wiki/b.md', 'exact'], ['wiki/a.md', 'wiki/c.md', 'semantic'], ['wiki/b.md', 'wiki/c.md', 'semantic'],
    ]);
  });

  it.each([0, 101, 1.5, NaN, Infinity])('rejects an invalid comparison limit %s', async (limit) => {
    await expect(comparison.similar('wiki/a.md', limit)).rejects.toThrow(RangeError);
    await expect(comparison.duplicates(limit)).rejects.toThrow(RangeError);
  });
});
