import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Inject, Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import type { Logger } from 'pino';
import { ApiError } from '../api/api-error.js';
import { UsersService } from '../auth/users.service.js';
import { LOGGER } from '../common/tokens.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import { LunaService } from '../luna/luna.service.js';
import { IndexerService } from '../rag/indexer.service.js';
import type { JobEvent, JobPhase, JobSource, WriteJob } from './write-job.types.js';
import { NoteWriterService } from './note-writer.service.js';
import { WriteJobsRepository } from './write-jobs.repository.js';

const execFileAsync = promisify(execFile);

@Injectable()
export class WriteJobsService implements OnApplicationShutdown {
  private enabled = false;
  private worker: Promise<void> | null = null;

  constructor(
    private readonly repository: WriteJobsRepository,
    private readonly luna: LunaService,
    private readonly indexer: IndexerService,
    private readonly repo: KnowledgeRepo,
    private readonly users: UsersService,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly eventsService: EventsService,
    @Optional() private readonly writer?: NoteWriterService,
  ) {}

  submit(input: { userId: number; input: string; source: JobSource; client?: string }): WriteJob {
    return this.enqueue(input);
  }

  private enqueue(input: { userId: number; input: string; source: JobSource; client?: string }, retryOf?: string): WriteJob {
    const id = randomUUID();
    this.repository.enqueue(id, input.userId, input.input, new Date().toISOString(), input.source, input.client);
    this.phase(id, 'queued', retryOf ? { retryOf } : null);
    const job = this.get(id)!;
    this.kick();
    return job;
  }

  retry(id: string): WriteJob {
    const job = this.get(id);
    if (!job) throw new ApiError(404, 'not_found', 'Write job not found');
    if (job.status !== 'failed') throw new ApiError(409, 'job_not_retryable', 'Only failed jobs can be retried');
    if (job.kind !== 'luna') {
      if (!this.writer) throw new Error('Direct writer is not configured');
      return this.writer.retry(job);
    }
    return this.enqueue({ userId: job.userId, input: job.input, source: job.source, ...(job.client === null ? {} : { client: job.client }) }, id);
  }

  cancel(id: string): WriteJob {
    if (!this.get(id)) throw new ApiError(404, 'not_found', 'Write job not found');
    if (!this.repository.cancelQueued(id, new Date().toISOString())) throw new ApiError(409, 'job_not_cancelable', 'Only queued jobs can be canceled');
    this.phase(id, 'failed', { reason: 'canceled' });
    return this.get(id)!;
  }

  events(id: string): JobEvent[] {
    return this.repository.events(id);
  }

  phase(id: string, phase: JobPhase, detail: Record<string, unknown> | null = null): void {
    this.repository.addEvent(id, phase, detail);
    const job = this.get(id)!;
    this.eventsService.publish({ type: 'job.updated', jobId: id, userId: job.userId, status: job.status, phase }, { userIds: [job.userId], admins: true });
  }

  get(id: string): WriteJob | null {
    return this.repository.get(id);
  }

  list(opts: { userId?: number; limit?: number; before?: string } = {}): WriteJob[] {
    return this.repository.list(opts);
  }

  start(): void {
    if (this.enabled) return;
    const interrupted = this.repository.failInterrupted(
      'Engine restarted before the write job completed; retry this failed job.',
      new Date().toISOString(),
    );
    for (const job of interrupted) this.phase(job.id, 'failed', { reason: 'interrupted' });
    this.enabled = true;
    this.writer?.resumeQueued();
    this.kick();
  }

  async stop(): Promise<void> {
    this.enabled = false;
    await this.worker;
    await this.writer?.stop();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  private kick(): void {
    if (!this.enabled || this.worker) return;
    // Deferring preserves submit's immediate queued response.
    this.worker = Promise.resolve().then(() => this.drain()).catch((error: unknown) => {
      this.log.error({ err: error }, 'Write job worker stopped unexpectedly');
      this.enabled = false;
    }).finally(() => {
      this.worker = null;
      // submit may enqueue between drain's final query and this continuation.
      if (this.enabled && this.repository.next()) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.enabled) {
      const job = this.repository.next();
      if (!job) return;
      await this.run(job);
    }
  }

  private async commits(wt: Worktree): Promise<string[]> {
    const { stdout } = await execFileAsync('git', [
      'rev-list', '--reverse', `${wt.baseSha}..HEAD`, '--not', 'main',
    ], { cwd: wt.path, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim() ? stdout.trim().split('\n') : [];
  }

  private async verifyResolution(wt: Worktree, conflicts: string[]): Promise<void> {
    const files = new Set([...conflicts, ...await wt.list()]);
    for (const file of files) {
      const content = await wt.read(file);
      if (content !== null && /^(?:<{7}|={7}|>{7}|\|{7})/m.test(content)) {
        throw new Error(`Unresolved conflict markers remain in ${file}`);
      }
    }
  }

  private async run(job: WriteJob): Promise<void> {
    const { repository, repo, luna, indexer, log } = this;
    let wt: Worktree | undefined;
    repository.markRunning(job.id, new Date().toISOString());
    this.phase(job.id, 'preparing');
    try {
      const user = this.users.getById(job.userId);
      if (!user) throw new Error(`Requesting user ${job.userId} no longer exists`);
      const author = { name: user.name || user.email, email: user.email };
      wt = await repo.createWorktree(job.id);
      wt.setCommitMetadata({ jobId: job.id, source: job.source, requester: user.email, ...(job.client === null ? {} : { client: job.client }) });
      wt.onPhase = (phase, detail) => this.phase(job.id, phase, detail);
      this.phase(job.id, 'editing');
      const { summary } = await luna.runWrite(this.get(job.id)!, wt, author);
      const subject = summary.trim().split(/\r?\n/, 1)[0]?.slice(0, 200) || 'Update knowledge';
      this.phase(job.id, 'committing');
      await wt.commit(subject, author);
      const writtenCommits = await this.commits(wt);
      repository.markMerging(job.id, summary, writtenCommits);
      const activeWorktree = wt;
      await repo.withMergeLock(async () => {
        this.phase(job.id, 'merging');
        const previousMain = await repo.headSha();
        const merge = await activeWorktree.mergeMain();
        if (!merge.ok) {
          repository.recordConflicts(job.id, merge.conflicts);
          this.phase(job.id, 'resolving_conflict', { files: merge.conflicts });
          await luna.resolveConflicts(activeWorktree, merge.conflicts);
          await this.verifyResolution(activeWorktree, merge.conflicts);
          await activeWorktree.finishMerge(author);
        }
        const commits = await this.commits(activeWorktree);
        const mergeSha = await activeWorktree.fastForwardMain();
        repository.recordMerge(job.id, commits, mergeSha);
        try {
          const changes = await repo.diffNames(previousMain, mergeSha);
          this.eventsService.publish({ type: 'main.updated', sha: mergeSha, paths: [...new Set(changes.flatMap((file) => file.oldPath ? [file.oldPath, file.path] : [file.path]))], jobId: job.id }, 'all');
          this.phase(job.id, 'indexing');
          await indexer.syncToHead();
        } catch (error) {
          log.error({ err: error, jobId: job.id, mergeSha }, 'Write merged but indexing failed');
          this.phase(job.id, 'indexing', { error: error instanceof Error ? error.message : String(error) });
        }
      });
      repository.markSucceeded(job.id, new Date().toISOString());
    } catch (error) {
      // Preserve Luna's commits for diagnosis even if it threw before producing a summary.
      if (wt) {
        try {
          repository.recordCommits(job.id, await this.commits(wt));
          await wt.preserveFailed(job.id);
        } catch (commitError) {
          log.warn({ err: commitError, jobId: job.id }, 'Could not record failed write commits');
        }
      }
      repository.markFailed(job.id, error instanceof Error ? error.message : String(error), new Date().toISOString());
      log.error({ err: error, jobId: job.id }, 'Write job failed');
    } finally {
      if (wt) {
        this.phase(job.id, 'cleanup');
        try {
          await wt.dispose();
        } catch (error) {
          // Cleanup does not invalidate an already-merged job; open prunes leftovers on boot.
          log.warn({ err: error, jobId: job.id }, 'Could not dispose write worktree');
        }
      }
      const result = this.get(job.id)!;
      this.phase(job.id, result.status === 'succeeded' ? 'done' : 'failed', result.error ? { error: result.error } : null);
    }
  }
}
