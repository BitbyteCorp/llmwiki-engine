import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { UsageService } from '../usage/usage.service.js';
import { chunkNote, normalizedNoteHash, wikilinkTargets, type NoteChunk } from './chunking.js';
import { embedTexts } from './embeddings.js';
import { NoteTargetResolver } from './link-resolver.js';

type PendingChunk = { id: number; content_hash: string; embedding_text: string };
type PreparedNote = { path: string; chunks: NoteChunk[]; targets: Array<{ name: string; text: string }>; updatedAt: string | null; author: string | null; normalizedHash: string };

function isIndexedPath(path: string): boolean {
  return path.toLowerCase().endsWith('.md') && path.toLowerCase() !== 'memory.md';
}

const LAYOUT_VERSION = '3';

@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private tail: Promise<unknown> = Promise.resolve();
  private needsRebuild = false;
  private vectorSignature: string | undefined;
  private syncing = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  private pollTask: Promise<void> | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Database.Database,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly repo: KnowledgeRepo,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly usage?: UsageService,
  ) {}

  onModuleInit(): void {
    this.init();
    if (this.config.jobsAutostart === false) return;
    this.poll = setInterval(() => {
      if (this.syncing || this.pollTask) return;
      this.pollTask = (async () => {
        const head = await this.repo.headSha();
        const pending = this.config.openaiApiKey && this.db.prepare('SELECT 1 FROM chunks WHERE vector_pending = 1 LIMIT 1').get();
        if (!this.syncing && (this.needsRebuild || head !== this.meta('indexed_sha') || pending)) await this.syncToHead();
      })().catch((error: unknown) => {
        this.setMeta('last_error', error instanceof Error ? error.message : String(error));
        this.log.error({ err: error }, 'External knowledge index synchronization failed');
      }).finally(() => { this.pollTask = undefined; });
    }, (this.config.indexPollSeconds ?? 60) * 1000);
    this.poll.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.poll);
    this.poll = undefined;
    await this.pollTask;
    await this.tail;
  }

  init(): void {
    const { config, db } = this;
    const model = this.meta('embedding_model');
    const dimensions = this.meta('embedding_dimensions');
    const mismatch = model !== config.embeddingModel || dimensions !== String(config.embeddingDimensions);
    const signature = `${config.embeddingModel}:${config.embeddingDimensions}`;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vectors'").get();
    if (!exists || (mismatch && this.vectorSignature !== signature)) {
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS chunk_vectors');
        db.exec(`CREATE VIRTUAL TABLE chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${config.embeddingDimensions}])`);
        db.exec('UPDATE chunks SET vector_pending = 1');
        if (mismatch && model !== null && dimensions !== null) this.setMeta('vector_mismatch', '1');
      })();
      this.needsRebuild = true;
    }
    if (this.meta('layout_version') !== LAYOUT_VERSION) this.needsRebuild = true;
    this.vectorSignature = signature;
  }

  syncToHead(): Promise<{ indexedSha: string; changedFiles: number }> {
    return this.serial(() => this.sync(false));
  }

  async rebuild(): Promise<void> {
    await this.serial(() => this.sync(true));
  }

  async reindex(options: { full?: boolean } = {}): Promise<{ indexedSha: string; changedFiles: number }> {
    return this.serial(() => this.sync(Boolean(options.full)));
  }

  async status() {
    const headSha = await this.repo.headSha();
    const indexedSha = this.meta('indexed_sha');
    // Aggregate rows have a fixed shape defined by this SQL, not note metadata.
    const pending = this.db.prepare('SELECT count(*) AS count FROM chunks WHERE vector_pending = 1').get() as { count: number };
    const pendingVectors = pending.count;
    const mismatch = this.meta('vector_mismatch') === '1'
      || this.meta('embedding_model') !== null && (this.meta('embedding_model') !== this.config.embeddingModel
        || this.meta('embedding_dimensions') !== String(this.config.embeddingDimensions));
    const lastError = mismatch ? 'vector_mismatch' : this.meta('last_error');
    return { indexedSha, headSha, syncing: this.syncing, lastSyncAt: this.meta('last_sync_at'), lastError,
      pendingVectors, embedding: { configured: Boolean(this.config.openaiApiKey), model: this.config.embeddingModel,
        dimensions: this.config.embeddingDimensions,
        ready: Boolean(this.config.openaiApiKey) && !lastError && !this.syncing && pendingVectors === 0 && indexedSha === headSha } };
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      this.syncing = true;
      this.events?.publish({ type: 'index.updated', sha: this.meta('indexed_sha'), status: 'syncing' }, 'all');
      try {
        return await operation();
      } catch (error) {
        this.setMeta('last_error', error instanceof Error ? error.message : String(error));
        this.events?.publish({ type: 'index.updated', sha: this.meta('indexed_sha'), status: 'error' }, 'all');
        throw error;
      } finally {
        this.syncing = false;
      }
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  private meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM index_meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO index_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
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
      if (markdown !== null) {
        const [touch] = await repo.log({ path, limit: 1, ref: head });
        notes.push({ path, chunks: chunkNote(path, markdown), targets: wikilinkTargets(markdown),
          updatedAt: touch?.committedAt ?? touch?.date ?? null, author: touch ? `${touch.authorName} <${touch.authorEmail}>` : null,
          normalizedHash: normalizedNoteHash(markdown) });
      }
    }
    const pending = full ? [] : (db.prepare(
      'SELECT id, path, content_hash, embedding_text FROM chunks WHERE vector_pending = 1',
    ).all() as Array<PendingChunk & { path: string }>).filter((chunk) => !removed.has(chunk.path));
    const inputs = new Map<string, string>();
    for (const note of notes) for (const chunk of note.chunks) inputs.set(chunk.contentHash, chunk.embeddingText);
    for (const chunk of pending) inputs.set(chunk.content_hash, chunk.embedding_text);
    const vectors = new Map<string, Buffer>();
    const generated = new Map<string, Buffer>();
    let embeddingError: string | null = null;
    if (config.openaiApiKey) {
      const cached = db.prepare('SELECT embedding FROM embedding_cache WHERE content_hash = ? AND model = ? AND dimensions = ?');
      const missing: Array<[string, string]> = [];
      for (const [hash, input] of inputs) {
        const row = cached.get(hash, config.embeddingModel, config.embeddingDimensions) as { embedding: Buffer } | undefined;
        if (row) vectors.set(hash, row.embedding);
        else missing.push([hash, input]);
      }
      if (missing.length) {
        try {
          const embeddings = await embedTexts(config, missing.map(([, input]) => input), undefined, ({ model, inputTokens }) => {
            this.usage?.record({ lane: 'embedding', model, inputTokens, cachedInputTokens: 0,
              outputTokens: 0, reasoningTokens: 0 });
          });
          for (let index = 0; index < missing.length; index++) {
            const bytes = Buffer.from(new Float32Array(embeddings[index]).buffer);
            vectors.set(missing[index]![0], bytes);
            generated.set(missing[index]![0], bytes);
          }
        } catch (error) {
          embeddingError = `embedding_error: ${error instanceof Error ? error.message : String(error)}`;
          this.log.warn({ err: error }, 'Embedding unavailable; advancing lexical knowledge index');
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
        (path,title,heading,content,embedding_text,content_hash,kind,ordinal,vector_pending,
         tags,tags_json,anchor,source_start,source_end,updated_at,author,normalized_hash)
        VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`);
      const insertLink = db.prepare('INSERT INTO links(source_path,target_name,target_text,target_path) VALUES (?,?,?,NULL)');
      for (const note of notes) {
        for (const chunk of note.chunks) insertChunk.run(note.path, chunk.title, chunk.heading, chunk.content,
          chunk.embeddingText, chunk.contentHash, chunk.kind, chunk.ordinal, chunk.tags.join(' '), JSON.stringify(chunk.tags),
          chunk.anchor, chunk.sourceStart, chunk.sourceEnd, note.updatedAt, note.author, note.normalizedHash);
        for (const target of note.targets) insertLink.run(note.path, target.name, target.text);
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
        const resolver = new NoteTargetResolver(allPaths);
        const updateLink = db.prepare('UPDATE links SET target_path = ? WHERE target_name = ?');
        for (const { target_name, target_text } of db.prepare('SELECT target_name,target_text FROM links GROUP BY target_name').all() as Array<{ target_name: string; target_text: string }>) {
          updateLink.run(resolver.resolve(target_text || target_name).path, target_name);
        }
      }
      this.setMeta('embedding_model', config.embeddingModel);
      this.setMeta('embedding_dimensions', String(config.embeddingDimensions));
      this.setMeta('indexed_sha', head);
      this.setMeta('layout_version', LAYOUT_VERSION);
      this.setMeta('last_sync_at', new Date().toISOString());
      this.setMeta('last_error', embeddingError);
      const pending = db.prepare('SELECT count(*) AS count FROM chunks WHERE vector_pending = 1').get() as { count: number };
      if (force && config.openaiApiKey && pending.count === 0 && embeddingError === null) this.setMeta('vector_mismatch', '0');
      // SHA can stay unchanged during a full/layout rebuild or pending-vector retry.
      this.setMeta('catalog_revision', String(Number(this.meta('catalog_revision') ?? '0') + 1));
    })();
    this.needsRebuild = false;
    this.events?.publish({ type: 'index.updated', sha: head,
      status: embeddingError || this.meta('vector_mismatch') === '1' ? 'error' : 'ready' }, 'all');
    return { indexedSha: head, changedFiles: relevant.length };
  }
}
