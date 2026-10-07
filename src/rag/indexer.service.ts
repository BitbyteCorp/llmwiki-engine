import { basename } from 'node:path/posix';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { chunkNote, wikilinkTargets, type NoteChunk } from './chunking.js';
import { embedTexts } from './embeddings.js';

type PendingChunk = { id: number; content_hash: string; embedding_text: string };
type PreparedNote = { path: string; chunks: NoteChunk[]; targets: string[] };

function isIndexedPath(path: string): boolean {
  return path.toLowerCase().endsWith('.md') && path.toLowerCase() !== 'memory.md';
}

@Injectable()
export class IndexerService implements OnModuleInit {
  private tail: Promise<unknown> = Promise.resolve();
  private needsRebuild = false;
  private vectorSignature: string | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Database.Database,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly repo: KnowledgeRepo,
  ) {}

  onModuleInit(): void {
    this.init();
  }

  init(): void {
    const { config, db } = this;
    const model = this.meta('embedding_model');
    const dimensions = this.meta('embedding_dimensions');
    const mismatch = model !== config.embeddingModel || dimensions !== String(config.embeddingDimensions);
    const signature = `${config.embeddingModel}:${config.embeddingDimensions}`;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vectors'").get();
    if (!exists || (mismatch && this.vectorSignature !== signature)) {
      // vec0 dimensions are part of its schema; a configuration change cannot reuse it.
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS chunk_vectors');
        db.exec(`CREATE VIRTUAL TABLE chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${config.embeddingDimensions}])`);
      })();
      this.needsRebuild = true;
    }
    if (mismatch) this.needsRebuild = true;
    this.vectorSignature = signature;
  }

  syncToHead(): Promise<{ indexedSha: string; changedFiles: number }> {
    return this.serial(() => this.sync(false));
  }

  async rebuild(): Promise<void> {
    await this.serial(() => this.sync(true));
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation);
    this.tail = task.catch(() => undefined);
    return task;
  }

  private meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private async sync(force: boolean): Promise<{ indexedSha: string; changedFiles: number }> {
    this.init();
    const { config, db, repo } = this;
    const head = await repo.headSha();
    const from = this.meta('indexed_sha');
    const full = force || this.needsRebuild || from === null;
    const changes = full || from !== head ? await repo.diffNames(full ? null : from, head) : [];
    const relevant = changes.filter((change) => isIndexedPath(change.path)
      || change.oldPath !== undefined && isIndexedPath(change.oldPath));
    const removed = new Set<string>();
    const updated = new Set<string>();
    for (const change of relevant) {
      if (isIndexedPath(change.path)) removed.add(change.path);
      if (change.oldPath && isIndexedPath(change.oldPath)) removed.add(change.oldPath);
      if (change.status !== 'D' && isIndexedPath(change.path)) updated.add(change.path);
    }
    const notes: PreparedNote[] = [];
    for (const path of updated) {
      const markdown = await repo.readFile(path, head);
      if (markdown !== null) notes.push({ path, chunks: chunkNote(path, markdown), targets: wikilinkTargets(markdown) });
    }
    const pending = full ? [] : (db.prepare(
      'SELECT id, path, content_hash, embedding_text FROM chunks WHERE vector_pending = 1',
    ).all() as Array<PendingChunk & { path: string }>).filter((chunk) => !removed.has(chunk.path));
    const inputs = new Map<string, string>();
    for (const note of notes) for (const chunk of note.chunks) inputs.set(chunk.contentHash, chunk.embeddingText);
    for (const chunk of pending) inputs.set(chunk.content_hash, chunk.embedding_text);
    const vectors = new Map<string, Buffer>();
    const generated = new Map<string, Buffer>();
    if (config.openaiApiKey) {
      const cached = db.prepare('SELECT embedding FROM embedding_cache WHERE content_hash = ? AND model = ? AND dimensions = ?');
      const missing: Array<[string, string]> = [];
      for (const [hash, input] of inputs) {
        const row = cached.get(hash, config.embeddingModel, config.embeddingDimensions) as { embedding: Buffer } | undefined;
        if (row) vectors.set(hash, row.embedding);
        else missing.push([hash, input]);
      }
      if (missing.length) {
        const embeddings = await embedTexts(config, missing.map(([, input]) => input));
        for (let index = 0; index < missing.length; index++) {
          const bytes = Buffer.from(new Float32Array(embeddings[index]).buffer);
          vectors.set(missing[index][0], bytes);
          generated.set(missing[index][0], bytes);
        }
      }
    }
    const allPaths = full || relevant.length ? (await repo.listFiles(undefined, head)).filter(isIndexedPath).sort() : null;
    db.transaction(() => {
      if (full) {
        db.exec('DELETE FROM chunk_vectors; DELETE FROM chunks; DELETE FROM links');
      } else {
        const ids = db.prepare('SELECT id FROM chunks WHERE path = ?');
        const deleteVector = db.prepare('DELETE FROM chunk_vectors WHERE chunk_id = ?');
        const deleteChunks = db.prepare('DELETE FROM chunks WHERE path = ?');
        const deleteLinks = db.prepare('DELETE FROM links WHERE source_path = ?');
        for (const path of removed) {
          for (const { id } of ids.all(path) as Array<{ id: number }>) deleteVector.run(BigInt(id));
          deleteChunks.run(path);
          deleteLinks.run(path);
        }
      }
      const insertChunk = db.prepare(`INSERT INTO chunks
        (path,title,heading,content,embedding_text,content_hash,kind,ordinal,vector_pending)
        VALUES (?,?,?,?,?,?,?,?,1)`);
      const insertLink = db.prepare('INSERT INTO links(source_path,target_name,target_path) VALUES (?,?,NULL)');
      for (const note of notes) {
        for (const chunk of note.chunks) insertChunk.run(note.path, chunk.title, chunk.heading, chunk.content,
          chunk.embeddingText, chunk.contentHash, chunk.kind, chunk.ordinal);
        for (const target of note.targets) insertLink.run(note.path, target);
      }
      const cache = db.prepare('INSERT OR REPLACE INTO embedding_cache(content_hash,model,dimensions,embedding) VALUES (?,?,?,?)');
      for (const [hash, bytes] of generated) cache.run(hash, config.embeddingModel, config.embeddingDimensions, bytes);
      const insertVector = db.prepare('INSERT INTO chunk_vectors(chunk_id,embedding) VALUES (?,?)');
      const markReady = db.prepare('UPDATE chunks SET vector_pending = 0 WHERE id = ?');
      for (const chunk of db.prepare('SELECT id,content_hash FROM chunks WHERE vector_pending = 1').all() as PendingChunk[]) {
        const vector = vectors.get(chunk.content_hash);
        if (vector) {
          insertVector.run(BigInt(chunk.id), vector);
          markReady.run(chunk.id);
        }
      }
      if (allPaths) {
        // Unresolved links remain stored so a later added/renamed note can resolve them.
        const byName = new Map<string, string>();
        for (const path of allPaths) {
          const name = basename(path).replace(/\.md$/i, '').toLowerCase();
          if (!byName.has(name)) byName.set(name, path);
        }
        const updateLink = db.prepare('UPDATE links SET target_path = ? WHERE target_name = ?');
        for (const { target_name } of db.prepare('SELECT DISTINCT target_name FROM links').all() as Array<{ target_name: string }>) {
          updateLink.run(byName.get(target_name) ?? null, target_name);
        }
      }
      const setMeta = db.prepare('INSERT INTO index_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      setMeta.run('embedding_model', config.embeddingModel);
      setMeta.run('embedding_dimensions', String(config.embeddingDimensions));
      setMeta.run('indexed_sha', head);
    })();
    this.needsRebuild = false;
    return { indexedSha: head, changedFiles: relevant.length };
  }
}
