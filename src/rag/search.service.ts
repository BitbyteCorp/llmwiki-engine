import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { embedTexts } from './embeddings.js';
import type { SearchHit } from './types.js';

interface ChunkRow {
  id: number;
  path: string;
  title: string;
  heading: string;
  content: string;
  kind: SearchHit['kind'];
}

interface FusedChunk {
  chunk: ChunkRow;
  score: number;
}

const candidates = 50;
const rrfConstant = 60;

@Injectable()
export class SearchService {
  private loggedMissingKey = false;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Database.Database,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async search(q: string, opts?: { limit?: number; kinds?: SearchHit['kind'][] }): Promise<SearchHit[]> {
    const limit = opts?.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Search limit must be an integer between 1 and 100');
    }
    const query = q.trim();
    if (!query || opts?.kinds?.length === 0) return [];

    const { db, config, log } = this;
    const kinds = opts?.kinds;
    const kindFilter = kinds ? ` AND c.kind IN (${kinds.map(() => '?').join(',')})` : '';
    const keywordRows = Array.from(query).length < 3 ? [] : db.prepare(`
      SELECT c.id, c.path, c.title, c.heading, c.content, c.kind
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?${kindFilter}
      ORDER BY bm25(chunks_fts), c.id
      LIMIT ${candidates}
    `).all(`"${query.replaceAll('"', '""')}"`, ...(kinds ?? [])) as ChunkRow[];

    let vectorRows: ChunkRow[] = [];
    if (!config.openaiApiKey) {
      if (!this.loggedMissingKey) {
        log.warn('OPENAI_API_KEY is missing; search uses keyword results only');
        this.loggedMissingKey = true;
      }
    } else if (this.vectorsMatchConfig()) {
      const [vector] = await embedTexts(config, [query]);
      // vec0 supports primary-key IN constraints before selecting its nearest k.
      // Filtering after KNN would starve kinds whose chunks rank below the global 50.
      vectorRows = db.prepare(`
        SELECT c.id, c.path, c.title, c.heading, c.content, c.kind
        FROM (
          SELECT chunk_id, distance FROM chunk_vectors
          WHERE embedding MATCH ? AND k = ${candidates}
            AND chunk_id IN (SELECT c.id FROM chunks c WHERE c.vector_pending = 0${kindFilter})
          ORDER BY distance
        ) v JOIN chunks c ON c.id = v.chunk_id
        ORDER BY v.distance, c.id
      `).all(Buffer.from(new Float32Array(vector!).buffer), ...(kinds ?? [])) as ChunkRow[];
    }

    const fused = new Map<number, FusedChunk>();
    for (const rows of [keywordRows, vectorRows]) {
      rows.forEach((chunk, index) => {
        const contribution = 1 / (rrfConstant + index + 1);
        const existing = fused.get(chunk.id);
        if (existing) existing.score += contribution;
        else fused.set(chunk.id, { chunk, score: contribution });
      });
    }

    const notes = new Map<string, { hit: SearchHit; best: FusedChunk }>();
    for (const entry of fused.values()) {
      const { chunk, score } = entry;
      const note = notes.get(chunk.path);
      if (!note) {
        notes.set(chunk.path, {
          hit: { path: chunk.path, title: chunk.title, heading: chunk.heading, snippet: chunk.content,
            score, kind: chunk.kind, related: [] },
          best: entry,
        });
      } else {
        note.hit.score += score;
        if (score > note.best.score || (score === note.best.score && chunk.id < note.best.chunk.id)) {
          note.best = entry;
          note.hit.heading = chunk.heading;
          note.hit.snippet = chunk.content;
        }
      }
    }

    const hits = [...notes.values()].map(({ hit }) => hit)
      .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit);
    const related = db.prepare(`
      SELECT target_path AS path FROM links WHERE source_path = ? AND target_path IS NOT NULL
      UNION
      SELECT source_path AS path FROM links WHERE target_path = ?
    `);
    for (const hit of hits) {
      hit.related = (related.all(hit.path, hit.path) as Array<{ path: string }>)
        .map(({ path }) => path).filter((path) => path !== hit.path).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    }
    return hits;
  }

  private vectorsMatchConfig(): boolean {
    const { db, config } = this;
    const metadata = db.prepare(`
      SELECT key, value FROM index_meta WHERE key IN ('embedding_model', 'embedding_dimensions')
    `).all() as Array<{ key: string; value: string }>;
    const values: Record<string, string> = Object.fromEntries(metadata.map(({ key, value }) => [key, value]));
    return values.embedding_model === config.embeddingModel
      && values.embedding_dimensions === String(config.embeddingDimensions)
      && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vectors'").get() !== undefined;
  }
}

