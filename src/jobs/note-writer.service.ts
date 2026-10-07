import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Logger } from 'pino';
import { ApiError } from '../api/api-error.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../auth/users.service.js';
import { AclService } from '../acl/acl.service.js';
import type { AclUser } from '../acl/acl.service.js';
import { LOGGER } from '../common/tokens.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo, repoPath, type FileChange, type Worktree } from '../knowledge/repo.js';
import { IndexerService } from '../rag/indexer.service.js';
import type { JobKind, JobPhase, JobSource, WriteJob } from './write-job.types.js';
import { WriteJobsRepository } from './write-jobs.repository.js';

export type NoteOp =
  | { op: 'put'; path: string; content?: string; contentBase64?: string; create?: boolean }
  | { op: 'delete'; path: string }
  | { op: 'move'; from: string; to: string };
export interface ApplyInput { userId: number; source: JobSource; ops: NoteOp[]; baseSha: string; message?: string; client?: string }
export interface WriteResult { jobId: string; mergeSha: string; changed: string[] }
export interface RevertInput { userId: number; sha: string; paths?: string[]; preview?: boolean; client?: string }

function notePath(input: string, importRaw = false): string {
  try {
    const path = repoPath(input);
    if (!path || (!path.endsWith('.md') && !path.startsWith('assets/') && !(importRaw && path.startsWith('raw/')))) throw new Error('Only Markdown notes, assets/ files, and import raw originals can be edited');
    return path;
  } catch (error) {
    throw new ApiError(400, 'invalid_note', error instanceof Error ? error.message : String(error));
  }
}

function changedPaths(files: FileChange[]): string[] {
  return [...new Set(files.flatMap((file) => file.oldPath ? [file.oldPath, file.path] : [file.path]))];
}

@Injectable()
export class NoteWriterService {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    private readonly repository: WriteJobsRepository,
    private readonly repo: KnowledgeRepo,
    private readonly users: UsersService,
    private readonly indexer: IndexerService,
    private readonly events: EventsService,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly acl: AclService,
    @Optional() private readonly audit?: AuditService,
  ) {}
  private phase(id: string, phase: JobPhase, detail: Record<string, unknown> | null = null): void {
    this.repository.addEvent(id, phase, detail);
    const job = this.repository.get(id)!;
    this.events.publish({ type: 'job.updated', jobId: id, userId: job.userId, status: job.status, phase }, { userIds: [job.userId], admins: true });
  }

  retry(original: WriteJob): WriteJob {
    const id = randomUUID();
    this.repository.enqueue(id, original.userId, original.input, new Date().toISOString(), original.source, original.client ?? undefined, original.kind);
    this.phase(id, 'queued', { retryOf: original.id });
    const job = this.repository.get(id)!;
    this.launch(job);
    return job;
  }
  resumeQueued(): void {
    for (const job of this.repository.queuedDirect()) this.launch(job);
  }

  async stop(): Promise<void> {
    await Promise.all(this.pending.values());
  }

  private launch(job: WriteJob): void {
    if (this.pending.has(job.id)) return;
    // Direct retries use the merge lock immediately, never the Luna queue.
    const execution = Promise.resolve().then(() => this.replay(job)).catch((error: unknown) => {
      if (this.repository.get(job.id)?.status !== 'failed') {
        this.repository.markFailed(job.id, error instanceof Error ? error.message : String(error), new Date().toISOString());
        this.phase(job.id, 'failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }).finally(() => this.pending.delete(job.id));
    this.pending.set(job.id, execution);
  }

  private async replay(job: WriteJob): Promise<void> {
    if (this.repository.get(job.id)?.status !== 'queued') return;
    const input = JSON.parse(job.input) as ApplyInput & RevertInput;
    if (job.kind === 'revert') await this.revertStored({ ...input, preview: false }, job.id);
    else await this.applyStored(input, job.id);
  }

  async apply(input: ApplyInput): Promise<WriteResult> {
    return this.applyStored(input);
  }
  private assertWrite(user: AclUser, path: string, source: JobSource): void {
    // Internal ingestion preserves immutable raw sources as system storage.
    // Integration into maintained notes always runs with requester ACLs.
    if (source === 'import' && path.startsWith('raw/')) {
      if (user.role !== 'editor' && user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Writing requires the editor or admin role');
      return;
    }
    this.acl.assertWrite(user, path);
  }


  private async applyStored(input: ApplyInput, jobId?: string): Promise<WriteResult> {
    const deleted = input.ops.filter((op) => op.op === 'delete').map((op) => op.path);
    try {
      if (!input.ops.length) throw new ApiError(400, 'invalid_note', 'At least one operation is required');
      const ops = input.ops.map((op): NoteOp => op.op === 'move'
        ? { ...op, from: notePath(op.from), to: notePath(op.to) }
        : { ...op, path: notePath(op.path, input.source === 'import') });
      const touched = new Set(ops.flatMap((op) => op.op === 'move' ? [op.from, op.to] : [op.path]));
      const requester = this.users.getById(input.userId);
      if (!requester) throw new ApiError(404, 'not_found', 'Requesting user no longer exists');
      for (const path of touched) this.assertWrite(requester, path, input.source);
      return await this.repo.withMergeLock(async () => {
        const head = await this.repo.headSha();
        let changes: FileChange[];
        try { changes = await this.repo.diffNames(input.baseSha, head); }
        catch { throw new ApiError(400, 'invalid_note', 'baseSha must identify an existing commit'); }
        if (changedPaths(changes).some((path) => touched.has(path))) {
          throw new ApiError(409, 'stale_note', `A touched path changed; current main SHA: ${head}`);
        }
        return this.run(input, 'direct', input.message || 'Update notes', async (wt) => {
          for (const op of ops) {
            const path = op.op === 'move' ? op.from : op.path;
            const exists = await wt.hasFile(path);
            if (path.startsWith('raw/') && exists) throw new ApiError(409, 'note_exists', 'Existing raw sources are immutable');
            if (path.startsWith('raw/') && op.op !== 'put') throw new ApiError(400, 'invalid_note', 'Raw sources cannot be deleted or moved');
            if (op.op === 'put') {
              if (op.create && exists) throw new ApiError(409, 'note_exists', `Note already exists: ${path}`);
              // Without create:true, put is an upsert.
              if ((op.content === undefined) === (op.contentBase64 === undefined)) throw new ApiError(400, 'invalid_note', 'Provide exactly one of content or contentBase64');
              if (op.contentBase64 !== undefined) {
                const encoded = op.contentBase64;
                const padding = encoded.indexOf('=');
                const validPadding = padding === -1 || padding === encoded.length - 1 || (padding === encoded.length - 2 && encoded.endsWith('=='));
                if ((!path.startsWith('assets/') && !(input.source === 'import' && path.startsWith('raw/'))) || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) || !validPadding) {
                  throw new ApiError(400, 'invalid_note', 'Binary content must be valid base64 under assets/ or import raw/');
                }
                await wt.write(path, Buffer.from(op.contentBase64, 'base64'));
              } else await wt.write(path, op.content!);
            } else {
              if (!exists) throw new ApiError(404, 'note_missing', `Note does not exist: ${path}`);
              if (op.op === 'delete') await wt.remove(path);
              else {
                if (op.to.startsWith('raw/')) throw new ApiError(400, 'invalid_note', 'Cannot move a note into immutable raw sources');
                if (await wt.hasFile(op.to)) throw new ApiError(409, 'note_exists', `Note already exists: ${op.to}`);
                await wt.move(path, op.to);
              }
            }
          }
        }, jobId);
      });
    } catch (error) {
      for (const path of deleted) this.audit?.record({ actorId: input.userId, action: 'note.delete', target: path, outcome: 'error', summary: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async applyRevert(input: RevertInput & { preview: true }): Promise<{ files: FileChange[]; patch: string }>;
  async applyRevert(input: RevertInput & { preview?: false }): Promise<WriteResult>;
  async applyRevert(input: RevertInput): Promise<WriteResult | { files: FileChange[]; patch: string }>;
  async applyRevert(input: RevertInput): Promise<WriteResult | { files: FileChange[]; patch: string }> {
    return this.revertStored(input);
  }

  private async revertStored(input: RevertInput, jobId?: string): Promise<WriteResult | { files: FileChange[]; patch: string }> {
    try {
      const paths = input.paths?.map((path) => repoPath(path));
      const requester = this.users.getById(input.userId);
      if (!requester) throw new ApiError(404, 'not_found', 'Requesting user no longer exists');
      const commit = await this.repo.show(input.sha);
      const selected = commit.files.filter((file) => !paths || paths.includes(file.path) || (file.oldPath !== undefined && paths.includes(file.oldPath)));
      for (const path of changedPaths(selected)) this.acl.assertWrite(requester, path);
      const result = await this.repo.withMergeLock(async () => {
        if (!input.preview) return this.run({ ...input, source: 'revert' }, 'revert', `Revert ${input.sha}`, async (wt) => {
          await wt.revert(input.sha, paths);
        }, jobId);
        const wt = await this.repo.createWorktree(`preview-${randomUUID()}`);
        try {
          await wt.revert(input.sha, paths);
          const diff = await wt.diff();
          const current = this.users.getById(input.userId);
          if (!current) throw new ApiError(404, 'not_found', 'Requesting user no longer exists');
          for (const path of changedPaths(diff.files)) this.acl.assertWrite(current, path);
          return diff;
        } finally { await wt.dispose(); }
      });
      if (!input.preview) this.audit?.record({ actorId: input.userId, action: 'history.revert', target: input.sha, outcome: 'success' });
      return result;
    } catch (error) {
      if (!input.preview) this.audit?.record({ actorId: input.userId, action: 'history.revert', target: input.sha, outcome: 'error', summary: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  // Caller holds the global merge lock from freshness check through indexing.
  private async run(input: { userId: number; source: JobSource; client?: string; ops?: NoteOp[]; sha?: string; paths?: string[] }, kind: JobKind, message: string, edit: (wt: Worktree) => Promise<void>, jobId?: string): Promise<WriteResult> {
    const id = jobId ?? randomUUID();
    if (!jobId) {
      this.repository.enqueue(id, input.userId, JSON.stringify(input), new Date().toISOString(), input.source, input.client, kind);
      this.phase(id, 'queued');
    }
    if (jobId && this.repository.get(jobId)?.status !== 'queued') throw new ApiError(409, 'job_not_retryable', 'Retried job is no longer queued');
    this.repository.markRunning(id, new Date().toISOString());
    this.phase(id, 'preparing');
    let wt: Worktree | undefined;
    try {
      const user = this.users.getById(input.userId);
      if (!user) throw new ApiError(404, 'not_found', 'Requesting user no longer exists');
      const author = { name: user.name || user.email, email: user.email };
      wt = await this.repo.createWorktree(id);
      wt.setCommitMetadata({ jobId: id, source: input.source, requester: user.email, ...(input.client === undefined ? {} : { client: input.client }) });
      this.phase(id, 'editing');
      await edit(wt);
      const current = this.users.getById(input.userId);
      if (!current) throw new ApiError(404, 'not_found', 'Requesting user no longer exists');
      for (const path of changedPaths((await wt.diff()).files)) this.assertWrite(current, path, input.source);
      this.phase(id, 'committing');
      const sha = await wt.commit(message, author);
      const changed = changedPaths(await this.repo.diffNames(wt.baseSha, sha ?? wt.baseSha));
      const commits = sha ? [sha] : [];
      this.repository.markMerging(id, message, commits);
      this.phase(id, 'merging');
      const mergingUser = this.users.getById(input.userId);
      if (!mergingUser) throw new ApiError(404, 'not_found', 'Requesting user no longer exists');
      for (const path of changed) this.assertWrite(mergingUser, path, input.source);
      const mergeSha = await wt.fastForwardMain();
      this.repository.recordMerge(id, commits, mergeSha);
      this.events.publish({ type: 'main.updated', sha: mergeSha, paths: changed, jobId: id }, 'all');
      this.phase(id, 'indexing');
      try { await this.indexer.syncToHead(); }
      catch (error) {
        this.log.error({ err: error, jobId: id, mergeSha }, 'Direct write merged but indexing failed');
        this.phase(id, 'indexing', { error: error instanceof Error ? error.message : String(error) });
      }
      this.repository.markSucceeded(id, new Date().toISOString());
      for (const op of input.ops ?? []) if (op.op === 'delete') this.audit?.record({ actorId: input.userId, action: 'note.delete', target: op.path, outcome: 'success' });
      return { jobId: id, mergeSha, changed };
    } catch (error) {
      if (wt) {
        try { await wt.preserveFailed(id); }
        catch (preserveError) { this.log.warn({ err: preserveError, jobId: id }, 'Could not preserve failed direct write'); }
      }
      this.repository.markFailed(id, error instanceof Error ? error.message : String(error), new Date().toISOString());
      throw error;
    } finally {
      if (wt) {
        this.phase(id, 'cleanup');
        try { await wt.dispose(); }
        catch (error) { this.log.warn({ err: error, jobId: id }, 'Could not dispose direct worktree'); }
      }
      const job = this.repository.get(id)!;
      this.phase(id, job.status === 'succeeded' ? 'done' : 'failed', job.error ? { error: job.error } : null);
    }
  }
}
