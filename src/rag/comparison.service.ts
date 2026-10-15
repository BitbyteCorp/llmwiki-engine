import { setImmediate } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { AclService, type AclUser } from '../acl/acl.service.js';

interface NoteIdentity { path: string; title: string }
interface Passage { anchor: string | null; excerpt: string }
export interface SimilarNote extends NoteIdentity { score: number }
export interface DuplicateOptions { pathPrefixes?: readonly string[] }
export interface DuplicateNotes {
  left: NoteIdentity;
  right: NoteIdentity;
  score: number;
  reason: 'exact' | 'semantic';
  passages: Array<{ left: Passage; right: Passage }>;
}
interface NoteRow extends NoteIdentity { normalized_hash: string | null }
interface VectorChunk {
  embedding: Buffer;
  norm: number;
  anchor: string | null;
  content: string;
}
interface VectorNote extends NoteRow {
  mean: Float64Array;
}
interface VectorState {
  key: string;
  model: string;
  dimensions: number;
  compatible: boolean;
}
interface VectorSnapshot extends VectorState {
  notes: Map<string, VectorNote>;
  // Undefined means full coverage; an empty array means nothing has been loaded.
  prefixes: readonly string[] | undefined;
}
interface VectorRow extends NoteRow {
  id: number;
  ordinal: number;
  embedding: Buffer;
}
const VECTOR_BATCH_SIZE = 32;
interface RankedPair {
  left: NoteRow;
  right: NoteRow;
  score: number;
  reason: DuplicateNotes['reason'];
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePair(left: RankedPair, right: RankedPair): number {
  return right.score - left.score || comparePath(left.left.path, right.left.path)
    || comparePath(left.right.path, right.right.path);
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Comparison limit must be an integer between 1 and 100');
  }
}

function cosine(left: Float64Array, right: Float64Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index]! * right[index]!;
  return Math.max(-1, Math.min(1, score));
}

function passage(chunk: { anchor: string | null; content: string }): Passage {
  const text = chunk.content.replace(/\s+/g, ' ').trim();
  // Avoid splitting UTF-16 surrogate pairs while keeping the API excerpt at <=240 characters.
  let end = Math.min(text.length, 240);
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return { anchor: chunk.anchor, excerpt: text.slice(0, end) };
}

@Injectable()
export class ComparisonService {
  private snapshot: VectorSnapshot | undefined;
  private population: Promise<void> | undefined;
  private readonly readVectorState;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Database.Database,
    @Inject(LOGGER) _log: Logger,
    private readonly acl: AclService,
  ) {
    this.readVectorState = db.prepare(`SELECT
      (SELECT value FROM index_meta WHERE key = 'indexed_sha') AS sha,
      COALESCE((SELECT value FROM index_meta WHERE key = 'catalog_revision'),
        CAST(total_changes() AS TEXT)) AS generation,
      (SELECT value FROM index_meta WHERE key = 'embedding_model') AS model,
      (SELECT value FROM index_meta WHERE key = 'embedding_dimensions') AS dimensions,
      (SELECT value FROM index_meta WHERE key = 'vector_mismatch') AS mismatch,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vectors') AS vectors`);
  }

  /** Omit user only for unrestricted internal system comparisons. */
  async similar(path: string, limit = 20, user?: AclUser): Promise<SimilarNote[]> {
    validateLimit(limit);
    if (user) this.acl.assertRead(user, path);
    const policyKey = user ? this.acl.policyKey(user) : undefined;
    retry: while (true) {
      const snapshot = await this.vectorSnapshot();
      this.assertPolicy(user, policyKey);
      if (!this.isCurrent(snapshot)) continue retry;
      const source = snapshot.notes.get(path);
      if (!source) return [];
      const matches: SimilarNote[] = [];
      const iterator = snapshot.notes.values();
      let complete = false;
      while (!complete) {
        {
          // The policy predicate belongs only to this synchronous scoring batch.
          const readable = user ? this.acl.readPredicate(user) : () => true;
          for (let count = 0; count < 256; count++) {
            const next = iterator.next();
            if (next.done) {
              complete = true;
              break;
            }
            const note = next.value;
            if (note.path !== path && readable(note.path)) {
              matches.push({ path: note.path, title: note.title, score: cosine(source.mean, note.mean) });
            }
          }
        }
        if (complete) break;
        await setImmediate();
        this.assertPolicy(user, policyKey);
        if (!this.isCurrent(snapshot)) continue retry;
      }
      matches.sort((left, right) => right.score - left.score || comparePath(left.path, right.path));
      this.assertPolicy(user, policyKey);
      return matches.slice(0, limit);
    }
  }

  async duplicates(limit = 20, user?: AclUser, options: DuplicateOptions = {}): Promise<DuplicateNotes[]> {
    validateLimit(limit);
    const policyKey = user ? this.acl.policyKey(user) : undefined;
    retry: while (true) {
      const snapshot = await this.vectorSnapshot(options.pathPrefixes);
      this.assertPolicy(user, policyKey);
      if (!this.isCurrent(snapshot)) continue retry;
      const access = this.noteFilter(user, options.pathPrefixes);
      const notes = this.db.prepare(`SELECT path, MIN(title) AS title, MIN(normalized_hash) AS normalized_hash
        FROM chunks c WHERE ${access.sql} GROUP BY path ORDER BY path`).all(...access.params) as NoteRow[];
      const exactGroups = new Map<string, NoteRow[]>();
      for (const note of notes) {
        if (!note.normalized_hash) continue;
        const group = exactGroups.get(note.normalized_hash);
        if (group) group.push(note);
        else exactGroups.set(note.normalized_hash, [note]);
      }
      // Keep only the requested best pairs; passages are computed only for those survivors.
      const ranked: RankedPair[] = [];
      const consider = (left: NoteRow, right: NoteRow, score: number, reason: RankedPair['reason']): void => {
        const candidate: RankedPair = { left, right, score, reason };
        if (ranked.length === limit && comparePair(candidate, ranked[ranked.length - 1]!) >= 0) return;
        let index = 0;
        while (index < ranked.length && comparePair(ranked[index]!, candidate) <= 0) index++;
        ranked.splice(index, 0, candidate);
        if (ranked.length > limit) ranked.pop();
      };
      let pairsSinceYield = 0;
      for (const group of exactGroups.values()) {
        for (let left = 0; left < group.length; left++) {
          for (let right = left + 1; right < group.length; right++) {
            consider(group[left]!, group[right]!, 1, 'exact');
            if (++pairsSinceYield === 1024) {
              pairsSinceYield = 0;
              await setImmediate();
              this.assertPolicy(user, policyKey);
              if (!this.isCurrent(snapshot)) continue retry;
            }
          }
        }
      }
      // SQL applies scope and the current ACL before either semantic pair loop.
      const semanticNotes = notes.flatMap((note) => {
        const vector = snapshot.notes.get(note.path);
        return vector ? [vector] : [];
      });
      for (let left = 0; left < semanticNotes.length; left++) {
        const a = semanticNotes[left]!;
        for (let right = left + 1; right < semanticNotes.length; right++) {
          if (++pairsSinceYield === 1024) {
            pairsSinceYield = 0;
            await setImmediate();
            this.assertPolicy(user, policyKey);
            if (!this.isCurrent(snapshot)) continue retry;
          }
          const b = semanticNotes[right]!;
          if (a.normalized_hash && a.normalized_hash === b.normalized_hash) continue;
          const score = cosine(a.mean, b.mean);
          if (score >= 0.98) consider(a, b, score, 'semantic');
        }
      }
      const passagePaths = new Set<string>();
      for (const pair of ranked) {
        if (pair.reason === 'semantic') {
          passagePaths.add(pair.left.path);
          passagePaths.add(pair.right.path);
        }
      }
      const chunks = await this.passageChunks(snapshot, [...passagePaths], user, policyKey);
      this.assertPolicy(user, policyKey);
      if (!chunks || !this.isCurrent(snapshot)) continue retry;
      const firstChunk = this.db.prepare('SELECT anchor, content FROM chunks WHERE path = ? ORDER BY ordinal, id LIMIT 1');
      const result: DuplicateNotes[] = [];
      for (const { left, right, score, reason } of ranked) {
        let passages: DuplicateNotes['passages'];
        if (reason === 'semantic') {
          passages = [await this.bestPassages(chunks.get(left.path)!, chunks.get(right.path)!, snapshot.dimensions, user, policyKey)];
          this.assertPolicy(user, policyKey);
          if (!this.isCurrent(snapshot)) continue retry;
        } else {
          const a = firstChunk.get(left.path) as { anchor: string | null; content: string };
          const b = firstChunk.get(right.path) as { anchor: string | null; content: string };
          passages = [{ left: passage(a), right: passage(b) }];
        }
        result.push({ left: { path: left.path, title: left.title }, right: { path: right.path, title: right.title }, score, reason, passages });
      }
      this.assertPolicy(user, policyKey);
      return result;
    }
  }

  private assertPolicy(user: AclUser | undefined, policyKey: string | undefined): void {
    if (user && this.acl.policyKey(user) !== policyKey) {
      throw new RangeError('Search policy changed; retry the query');
    }
  }

  private noteFilter(user?: AclUser, pathPrefixes?: readonly string[]): { sql: string; params: Array<string | number> } {
    const access = user ? this.acl.sql(user, 'c.path') : { sql: '1', params: [] };
    if (pathPrefixes === undefined) return access;
    return {
      sql: `(${access.sql}) AND (${pathPrefixes.map(() => 'substr(c.path, 1, ?) = ?').join(' OR ') || '0'})`,
      params: [...access.params, ...pathPrefixes.flatMap((prefix) => [prefix.length, prefix])],
    };
  }

  private vectorState(): VectorState {
    const stored = this.readVectorState.get() as {
      sha: string | null; generation: string; model: string | null;
      dimensions: string | null; mismatch: string | null; vectors: number;
    };
    const { embeddingModel: model, embeddingDimensions: dimensions } = this.config;
    return {
      key: JSON.stringify([stored, model, dimensions]),
      model, dimensions,
      compatible: Boolean(model) && Number.isInteger(dimensions) && dimensions > 0
        && stored.model === model && stored.dimensions === String(dimensions)
        && stored.mismatch !== '1' && stored.vectors === 1,
    };
  }

  private isCurrent(snapshot: VectorState): boolean {
    return snapshot.key === this.vectorState().key;
  }

  private covers(snapshot: VectorSnapshot, prefixes?: readonly string[]): boolean {
    return snapshot.prefixes === undefined || (prefixes !== undefined
      && prefixes.every((prefix) => snapshot.prefixes!.some((covered) => prefix.startsWith(covered))));
  }

  private async vectorSnapshot(prefixes?: readonly string[]): Promise<VectorSnapshot> {
    while (true) {
      const state = this.vectorState();
      if (this.snapshot?.key === state.key && this.covers(this.snapshot, prefixes)) return this.snapshot;
      // Only one population runs, including when callers ask for different scopes.
      if (this.population) {
        await this.population;
        continue;
      }
      const base = this.snapshot?.key === state.key ? this.snapshot : undefined;
      const pending = this.populateSnapshot(state, base, prefixes);
      this.population = pending;
      try { await pending; }
      finally { this.population = undefined; }
    }
  }

  private async populateSnapshot(state: VectorState, base: VectorSnapshot | undefined, prefixes?: readonly string[]): Promise<void> {
    if (!state.compatible) {
      this.snapshot = { ...state, notes: new Map(), prefixes: undefined };
      return;
    }
    const scope = this.noteFilter(undefined, prefixes);
    const covered = this.noteFilter(undefined, base?.prefixes ?? []);
    // Covered prefixes are excluded in SQL: promoting wiki-only coverage must not
    // decode it again, and a scoped request must never warm unrelated raw rows.
    const filter = `(${scope.sql}) AND NOT (${covered.sql})`;
    const rows = this.db.prepare(`SELECT c.path, c.title, c.normalized_hash, c.ordinal, c.id, e.embedding
      FROM chunks c JOIN embedding_cache e ON e.content_hash = c.content_hash AND e.model = ? AND e.dimensions = ?
      WHERE c.vector_pending = 0 AND ${filter}
        AND (c.path, c.ordinal, c.id) > (?, ?, ?)
      ORDER BY c.path, c.ordinal, c.id LIMIT ${VECTOR_BATCH_SIZE}`);
    const additions = new Map<string, VectorNote>();
    let cursor: [string, number, number] = ['', -1, -1];
    let current: VectorNote | undefined;
    const finish = () => {
      if (!current) return;
      let squaredNorm = 0;
      for (const value of current.mean) squaredNorm += value * value;
      if (!(squaredNorm > 0) || !Number.isFinite(squaredNorm)) return;
      const norm = Math.sqrt(squaredNorm);
      // Normalizing the sum equals normalizing the mean, without a chunk-count division.
      for (let index = 0; index < state.dimensions; index++) current.mean[index]! /= norm;
      additions.set(current.path, current);
    };
    while (true) {
      // Materialize a bounded batch; never retain a SQLite iterator across await.
      const batch = rows.all(state.model, state.dimensions, ...scope.params, ...covered.params, ...cursor) as VectorRow[];
      for (const row of batch) {
        cursor = [row.path, row.ordinal, row.id];
        if (current?.path !== row.path) {
          finish();
          current = undefined;
        }
        if (this.vectorNorm(row.embedding, state.dimensions) === undefined) continue;
        current ??= { path: row.path, title: row.title, normalized_hash: row.normalized_hash,
          mean: new Float64Array(state.dimensions) };
        for (let index = 0; index < state.dimensions; index++) {
          current.mean[index]! += row.embedding.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
        }
      }
      if (batch.length < VECTOR_BATCH_SIZE) break;
      await setImmediate();
      // An index transaction may have replaced rows behind the pagination key.
      // Discard all additions rather than publishing a mixed-generation mean.
      if (!this.isCurrent(state)) return;
    }
    finish();
    if (!this.isCurrent(state)) return;
    const notes = new Map(base?.notes);
    for (const [path, note] of additions) notes.set(path, note);
    this.snapshot = { ...state, notes,
      prefixes: prefixes === undefined ? undefined : [...(base?.prefixes ?? []), ...prefixes] };
  }

  private vectorNorm(bytes: Buffer, dimensions: number): number | undefined {
    if (bytes.length !== dimensions * Float32Array.BYTES_PER_ELEMENT) return undefined;
    let squaredNorm = 0;
    for (let index = 0; index < dimensions; index++) {
      const value = bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
      squaredNorm += value * value;
    }
    return squaredNorm > 0 && Number.isFinite(squaredNorm) ? Math.sqrt(squaredNorm) : undefined;
  }

  private async passageChunks(snapshot: VectorSnapshot, paths: string[], user: AclUser | undefined,
    policyKey: string | undefined): Promise<Map<string, VectorChunk[]> | undefined> {
    const chunks = new Map<string, VectorChunk[]>();
    if (!paths.length) return chunks;
    const rows = this.db.prepare(`SELECT c.path, c.ordinal, c.id, c.anchor, c.content, e.embedding
      FROM chunks c JOIN embedding_cache e ON e.content_hash = c.content_hash AND e.model = ? AND e.dimensions = ?
      WHERE c.vector_pending = 0 AND c.path IN (${paths.map(() => '?').join(',')})
        AND (c.path, c.ordinal, c.id) > (?, ?, ?)
      ORDER BY c.path, c.ordinal, c.id LIMIT ${VECTOR_BATCH_SIZE}`);
    let cursor: [string, number, number] = ['', -1, -1];
    while (true) {
      const batch = rows.all(snapshot.model, snapshot.dimensions, ...paths, ...cursor) as Array<VectorRow & { anchor: string | null; content: string }>;
      for (const row of batch) {
        cursor = [row.path, row.ordinal, row.id];
        const norm = this.vectorNorm(row.embedding, snapshot.dimensions);
        if (norm === undefined) continue;
        const noteChunks = chunks.get(row.path) ?? [];
        if (!chunks.has(row.path)) chunks.set(row.path, noteChunks);
        noteChunks.push({ embedding: row.embedding, norm, anchor: row.anchor, content: row.content });
      }
      if (batch.length < VECTOR_BATCH_SIZE) return chunks;
      await setImmediate();
      this.assertPolicy(user, policyKey);
      if (!this.isCurrent(snapshot)) return undefined;
    }
  }

  private async bestPassages(left: VectorChunk[], right: VectorChunk[], dimensions: number,
    user: AclUser | undefined, policyKey: string | undefined): Promise<{ left: Passage; right: Passage }> {
    let bestLeft = left[0]!;
    let bestRight = right[0]!;
    let bestScore = -Infinity;
    let sinceYield = 0;
    for (const a of left) {
      for (const b of right) {
        let dot = 0;
        for (let index = 0; index < dimensions; index++) {
          const offset = index * Float32Array.BYTES_PER_ELEMENT;
          dot += a.embedding.readFloatLE(offset) * b.embedding.readFloatLE(offset);
        }
        const score = dot / (a.norm * b.norm);
        if (score > bestScore) {
          bestScore = score;
          bestLeft = a;
          bestRight = b;
        }
        if (++sinceYield === 256) {
          sinceYield = 0;
          await setImmediate();
          this.assertPolicy(user, policyKey);
        }
      }
    }
    return { left: passage(bestLeft), right: passage(bestRight) };
  }
}
