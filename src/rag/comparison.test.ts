import { setImmediate } from 'node:timers/promises';
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
    reads.mockRestore();

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
