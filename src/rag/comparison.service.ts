import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { AclService, type AclUser } from '../acl/acl.service.js';

interface NoteIdentity { path: string; title: string }
interface Passage { anchor: string | null; excerpt: string }
export interface SimilarNote extends NoteIdentity { score: number }
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
  chunks: VectorChunk[];
}
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
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Database.Database,
    @Inject(LOGGER) _log: Logger,
    private readonly acl: AclService,
  ) {}

  /** Omit user only for unrestricted internal system comparisons. */
  async similar(path: string, limit = 20, user?: AclUser): Promise<SimilarNote[]> {
    validateLimit(limit);
    if (user) this.acl.assertRead(user, path);
    const notes = this.vectorNotes(false, user);
    const source = notes.get(path);
    if (!source) return [];
    const matches: SimilarNote[] = [];
    for (const note of notes.values()) {
      if (note.path !== path) matches.push({ path: note.path, title: note.title, score: cosine(source.mean, note.mean) });
    }
    matches.sort((left, right) => right.score - left.score || comparePath(left.path, right.path));
    return matches.slice(0, limit);
  }

  async duplicates(limit = 20, user?: AclUser): Promise<DuplicateNotes[]> {
    validateLimit(limit);
    const access = user ? this.acl.sql(user, 'c.path') : { sql: '1', params: [] };
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
    for (const group of exactGroups.values()) {
      for (let left = 0; left < group.length; left++) {
        for (let right = left + 1; right < group.length; right++) consider(group[left]!, group[right]!, 1, 'exact');
      }
    }
    const vectorNotes = this.vectorNotes(true, user);
    const semanticNotes = [...vectorNotes.values()];
    for (let left = 0; left < semanticNotes.length; left++) {
      const a = semanticNotes[left]!;
      for (let right = left + 1; right < semanticNotes.length; right++) {
        const b = semanticNotes[right]!;
        if (a.normalized_hash && a.normalized_hash === b.normalized_hash) continue;
        const score = cosine(a.mean, b.mean);
        if (score >= 0.98) consider(a, b, score, 'semantic');
      }
    }
    const firstChunk = this.db.prepare('SELECT anchor, content FROM chunks WHERE path = ? ORDER BY ordinal, id LIMIT 1');
    return ranked.map(({ left, right, score, reason }) => {
      let passages: DuplicateNotes['passages'];
      if (reason === 'semantic') {
        passages = [this.bestPassages(vectorNotes.get(left.path)!, vectorNotes.get(right.path)!)];
      } else {
        const a = firstChunk.get(left.path) as { anchor: string | null; content: string };
        const b = firstChunk.get(right.path) as { anchor: string | null; content: string };
        passages = [{ left: passage(a), right: passage(b) }];
      }
      return { left: { path: left.path, title: left.title }, right: { path: right.path, title: right.title }, score, reason, passages };
    });
  }

  private vectorNotes(includeChunks: boolean, user?: AclUser): Map<string, VectorNote> {
    const notes = new Map<string, VectorNote>();
    const { embeddingModel: model, embeddingDimensions: dimensions } = this.config;
    if (!model || !Number.isInteger(dimensions) || dimensions < 1) return notes;
    const metadata = this.db.prepare(`SELECT key, value FROM index_meta
      WHERE key IN ('embedding_model', 'embedding_dimensions', 'vector_mismatch')`).all() as Array<{ key: string; value: string }>;
    if (!metadata.some((row) => row.key === 'embedding_model' && row.value === model)
      || !metadata.some((row) => row.key === 'embedding_dimensions' && row.value === String(dimensions))
      || metadata.some((row) => row.key === 'vector_mismatch' && row.value === '1')
      || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vectors'").get()) return notes;

    const access = user ? this.acl.sql(user, 'c.path') : { sql: '1', params: [] };
    const rows = this.db.prepare(`SELECT c.path, c.title, c.normalized_hash, e.embedding
      ${includeChunks ? ', c.anchor, c.content' : ''}
      FROM chunks c JOIN embedding_cache e ON e.content_hash = c.content_hash AND e.model = ? AND e.dimensions = ?
      WHERE c.vector_pending = 0 AND (${access.sql}) ORDER BY c.path, c.ordinal, c.id`).iterate(model, dimensions, ...access.params);
    for (const row of rows as Iterable<NoteRow & { embedding: Buffer; anchor?: string | null; content?: string }>) {
      const bytes = row.embedding;
      if (bytes.length !== dimensions * Float32Array.BYTES_PER_ELEMENT) continue;
      let squaredNorm = 0;
      for (let index = 0; index < dimensions; index++) {
        const value = bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
        squaredNorm += value * value;
      }
      if (!(squaredNorm > 0) || !Number.isFinite(squaredNorm)) continue;
      let note = notes.get(row.path);
      if (!note) {
        note = { path: row.path, title: row.title, normalized_hash: row.normalized_hash,
          mean: new Float64Array(dimensions), chunks: [] };
        notes.set(row.path, note);
      }
      for (let index = 0; index < dimensions; index++) note.mean[index]! += bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
      if (includeChunks) note.chunks.push({ embedding: bytes, norm: Math.sqrt(squaredNorm), anchor: row.anchor ?? null, content: row.content! });
    }
    for (const [path, note] of notes) {
      let squaredNorm = 0;
      for (const value of note.mean) squaredNorm += value * value;
      if (!(squaredNorm > 0) || !Number.isFinite(squaredNorm)) {
        notes.delete(path);
        continue;
      }
      const norm = Math.sqrt(squaredNorm);
      // Normalizing the sum equals normalizing the mean, without a redundant division by chunk count.
      for (let index = 0; index < dimensions; index++) note.mean[index]! /= norm;
    }
    return notes;
  }

  private bestPassages(left: VectorNote, right: VectorNote): { left: Passage; right: Passage } {
    let bestLeft = left.chunks[0]!;
    let bestRight = right.chunks[0]!;
    let bestScore = -Infinity;
    for (const a of left.chunks) {
      for (const b of right.chunks) {
        let dot = 0;
        for (let index = 0; index < this.config.embeddingDimensions; index++) {
          const offset = index * Float32Array.BYTES_PER_ELEMENT;
          dot += a.embedding.readFloatLE(offset) * b.embedding.readFloatLE(offset);
        }
        const score = dot / (a.norm * b.norm);
        if (score > bestScore) {
          bestScore = score;
          bestLeft = a;
          bestRight = b;
        }
      }
    }
    return { left: passage(bestLeft), right: passage(bestRight) };
  }
}
