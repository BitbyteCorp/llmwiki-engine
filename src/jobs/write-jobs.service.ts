import { execFile } from 'node:child_process';
import { newId } from '../common/ids.js';
import { promisify } from 'node:util';
import { Inject, Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import type { Logger } from 'pino';
import { ApiError } from '../api/api-error.js';
import { UsersService } from '../auth/users.service.js';
import { AclService } from '../acl/acl.service.js';
import type { AclUser } from '../acl/acl.service.js';
import { CONFIG, LOGGER } from '../common/tokens.js';
import type { Config } from '../config.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import { sliceCodePoints } from '../agent/output.js';
import { AgentService } from '../agent/agent.service.js';
import type { TokenUsage } from '../agent/agent.types.js';
import { repairNoteMetadata, type NoteMetadataIssues } from '../agent/metadata-repair.js';
import { ENGINE_FIELDS, isMetadataTarget, validateNoteMetadata } from '../knowledge/note-metadata.js';
import { IndexerService } from '../rag/indexer.service.js';
import type { JobEvent, JobPhase, SubmittedWriteJob, SubmitWriteJob, WriteJob } from './write-job.types.js';
import { NoteWriterService } from './note-writer.service.js';
import { WriteJobsRepository } from './write-jobs.repository.js';

const execFileAsync = promisify(execFile);

@Injectable()
export class WriteJobsService implements OnApplicationShutdown {
  private enabled = false;
  private worker: Promise<void> | null = null;

  constructor(
    private readonly repository: WriteJobsRepository,
    private readonly agent: AgentService,
    private readonly indexer: IndexerService,
    private readonly repo: KnowledgeRepo,
    private readonly users: UsersService,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly eventsService: EventsService,
    private readonly acl: AclService,
    @Optional() private readonly writer?: NoteWriterService,
    @Optional() @Inject(CONFIG) private readonly config?: Config,
  ) {}

  submit(input: SubmitWriteJob): SubmittedWriteJob {
    if (input.dedupeKey !== undefined) {
      const existing = this.repository.getByDedupeKey(input.dedupeKey);
      if (existing) return { ...existing, reused: true };
    }
    return { ...this.enqueue(input), reused: false };
  }

  private enqueue(input: SubmitWriteJob, retryOf?: string): WriteJob {
    const id = newId();
    const sourcePaths = [...new Set([...(input.sourcePaths ?? []), ...(input.requiredReads ?? [])])];
    const detail = { sourceProvenanceComplete: true, ...(sourcePaths.length ? { sourcePaths } : {}), ...(retryOf ? { retryOf } : {}) };
    this.repository.enqueue(id, input.userId, input.input, new Date().toISOString(), input.source, input.client, 'agent', input.dedupeKey, retryOf, detail, input.requiredReads);
    this.publishPhase(id, 'queued');
    const job = this.get(id)!;
    this.kick();
    return job;
  }

  retry(id: string): WriteJob {
    const job = this.get(id);
    if (!job) throw new ApiError(404, 'not_found', 'Write job not found');
    if (job.status !== 'failed') throw new ApiError(409, 'job_not_retryable', 'Only failed jobs can be retried');
    if (job.kind !== 'agent') {
      if (!this.writer) throw new Error('Direct writer is not configured');
      return this.writer.retry(job);
    }
    const requester = this.users.getById(job.userId);
    if (!requester) throw new ApiError(404, 'not_found', 'Requesting user no longer exists');
    if (requester.role !== 'admin' && this.acl.list().length && !this.repository.events(job.id).some(event => event.phase === 'queued' && event.detail?.sourceProvenanceComplete === true)) {
      throw new ApiError(404, 'not_found', 'Legacy job source permissions cannot be verified; submit a new request');
    }
    return this.enqueue({ userId: job.userId, input: job.input, source: job.source, sourcePaths: this.sourcePaths(job.id), requiredReads: this.repository.getRequiredReads(job.id), ...(job.client === null ? {} : { client: job.client }) }, job.id);
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
    this.publishPhase(id, phase);
  }

  private publishPhase(id: string, phase: JobPhase): void {
    const job = this.get(id)!;
    this.eventsService.publish({ type: 'job.updated', jobId: job.id, userId: job.userId, status: job.status, phase }, { userIds: [job.userId], admins: true });
  }

  get(id: string): WriteJob | null {
    return this.repository.get(id);
  }

  async isResumable(job: WriteJob): Promise<boolean> {
    if (job.kind !== 'agent' || job.status !== 'failed') return false;
    if (this.repository.checkpoints.get(`job:${job.id}`)) return true;
    return (await this.retryBase(job.id)) !== undefined;
  }

  private retryOf(id: string): string | undefined {
    const value = this.repository.events(id).find(event => event.phase === 'queued')?.detail?.retryOf;
    return typeof value === 'string' ? value : undefined;
  }

  private async retryBase(id: string): Promise<string | undefined> {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && !visited.has(current)) {
      visited.add(current);
      const state = await this.repo.failedState(current);
      if (state.commits || state.wip) return current;
      current = this.retryOf(current);
    }
    return undefined;
  }

  async waitForSettled(id: string, timeoutMs: number, signal?: AbortSignal): Promise<{ job: WriteJob; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const job = this.repository.get(id);
      if (!job) throw new Error('not found');
      if (job.status === 'succeeded' || job.status === 'failed') return { job, timedOut: false };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { job, timedOut: true };
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, Math.min(1000, remaining));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  /** Public job projection: never return source text or metadata for hidden changes. */
  async visible(user: AclUser, job: WriteJob): Promise<WriteJob> {
    return (await this.projectVisibility(user, job)).job;
  }

  async projectVisibility(user: AclUser, job: WriteJob): Promise<{ job: WriteJob; sourcePaths: string[]; restricted: boolean }> {
    const policy = this.acl.policyKey(user);
    const paths = new Set(job.conflicts);
    for (const path of this.sourcePaths(job.id)) paths.add(path);
    let hidden = user.role !== 'admin' && job.kind === 'agent' && this.acl.list().length > 0 && !this.repository.events(job.id).some(event => event.phase === 'queued' && event.detail?.sourceProvenanceComplete === true);
    for (const sha of new Set([...job.commits, ...(job.mergeSha ? [job.mergeSha] : [])])) {
      try {
        for (const path of await this.repo.changedPaths(sha)) paths.add(path);
      } catch { hidden ||= user.role !== 'admin'; }
    }
    if (job.kind !== 'agent') {
      try {
        const input = JSON.parse(job.input) as { ops?: Array<{ path?: string; from?: string; to?: string }>; paths?: string[]; sha?: string };
        for (const op of input.ops ?? []) for (const path of [op.path, op.from, op.to]) if (path) paths.add(path);
        for (const path of input.paths ?? []) paths.add(path);
        if (input.sha) for (const path of await this.repo.changedPaths(input.sha)) paths.add(path);
      } catch { hidden ||= user.role !== 'admin'; }
    }
    hidden ||= [...paths].some((path) => !this.acl.canRead(user, path));
    const current = this.users.getById(user.id);
    if (!current || this.acl.policyKey(current) !== policy) throw new ApiError(404, 'not_found', 'Job details changed; request them again');
    const visible = hidden
      ? { ...job, input: '', summary: null, error: job.status === 'failed' ? 'Job details are unavailable under current folder permissions.' : null, commits: [], conflicts: [], mergeSha: null }
      : job;
    return { job: visible, sourcePaths: [...paths], restricted: hidden };
  }

  private sourcePaths(id: string): string[] {
    const paths = new Set<string>();
    for (const event of this.repository.events(id)) {
      if (typeof event.detail?.sourcePath === 'string') paths.add(event.detail.sourcePath);
      if (Array.isArray(event.detail?.sourcePaths)) for (const path of event.detail.sourcePaths) if (typeof path === 'string') paths.add(path);
    }
    return [...paths];
  }


  list(opts: { userId?: number; limit?: number; before?: string } = {}): WriteJob[] {
    return this.repository.list(opts);
  }

  start(): void {
    if (this.config?.jobsAutostart === false || this.enabled) return;
    const interrupted = this.repository.failInterrupted(
      'Engine restarted before the write job completed; retry this failed job.',
      new Date().toISOString(),
    );
    for (const job of interrupted) this.publishPhase(job.id, 'failed');
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

  private async assertWritable(wt: Worktree, userId: number, jobId: string, base = wt.baseSha): Promise<void> {
    const user = this.users.getById(userId);
    if (!user) throw new Error('Requesting user no longer exists');
    for (const path of this.sourcePaths(jobId)) {
      if (!this.acl.canRead(user, path)) throw new Error('Source access denied by current folder permissions; main was not changed');
    }
    const files = await this.repo.diffNames(base, wt.branch);
    for (const path of new Set(files.flatMap((file) => file.oldPath ? [file.oldPath, file.path] : [file.path]))) {
      if (!this.acl.canWrite(user, path)) throw new Error('Write denied by current folder permissions; main was not changed');
    }
  }

  private async metadataIssues(wt: Worktree, base = wt.baseSha): Promise<NoteMetadataIssues[]> {
    const issues: NoteMetadataIssues[] = [];
    const files = await this.repo.diffNames(base, wt.branch);
    for (const file of files) {
      if (file.status === 'D' || !isMetadataTarget(file.path)) continue;
      const content = await wt.read(file.path);
      if (content === null) continue;
      const remaining = validateNoteMetadata(file.path, content)
        .filter(issue => !(ENGINE_FIELDS as readonly string[]).includes(issue.field));
      if (remaining.length) issues.push({ path: file.path, issues: remaining });
    }
    return issues;
  }

  private async run(job: WriteJob): Promise<void> {
    const { repository, repo, agent, indexer, log } = this;
    let wt: Worktree | undefined;
    let metadataIssues: NoteMetadataIssues[] = [];
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const onUsage = (delta: TokenUsage) => {
      usage.inputTokens += delta.inputTokens;
      usage.cachedInputTokens += delta.cachedInputTokens ?? 0;
      usage.outputTokens += delta.outputTokens;
      usage.reasoningTokens += delta.reasoningTokens;
    };
    repository.markRunning(job.id, new Date().toISOString());
    this.phase(job.id, 'preparing');
    try {
      const user = this.users.getById(job.userId);
      if (!user) throw new Error(`Requesting user ${job.userId} no longer exists`);
      if (user.role !== 'admin' && this.acl.list().length && !this.repository.events(job.id).some(event => event.phase === 'queued' && event.detail?.sourceProvenanceComplete === true)) {
        throw new Error('Legacy job source permissions cannot be verified; submit a new request');
      }
      for (const path of this.sourcePaths(job.id)) this.acl.assertRead(user, path);
      const author = { name: user.name || user.email, email: user.email };
      const retryOf = this.retryOf(job.id);
      wt = await repo.createWorktree(job.id, retryOf ? await this.retryBase(retryOf) : undefined);
      wt.setCommitMetadata({ jobId: job.id, source: job.source, requester: user.email, ...(job.client === null ? {} : { client: job.client }) });
      wt.onPhase = (phase, detail) => this.phase(job.id, phase, detail);
      this.phase(job.id, 'editing');
      const { summary } = await agent.runWrite(this.get(job.id)!, wt, author, user, {
        requiredReads: repository.getRequiredReads(job.id),
        resume: repository.checkpoints.get(`job:${job.id}`),
        onCheckpoint: checkpoint => repository.checkpoints.save(`job:${job.id}`, checkpoint),
        onUsage,
      });
      const subject = sliceCodePoints(summary.trim().split(/\r?\n/, 1)[0] ?? '', 0, 200) || 'Update knowledge';
      this.phase(job.id, 'committing');
      await wt.commit(subject, author);
      await this.assertWritable(wt, job.userId, job.id);
      metadataIssues = await this.metadataIssues(wt);
      if (metadataIssues.length) {
        this.phase(job.id, 'editing', { metadataRepair: 'started', metadataIssues });
        try {
          await repairNoteMetadata(agent, wt, metadataIssues, author, user, { onUsage });
        } catch (error) {
          // Metadata quality is non-blocking: keep the user's knowledge even if the repair model fails.
          log.warn({ err: error, jobId: job.id }, 'Metadata repair failed; preserving knowledge');
          this.phase(job.id, 'editing', { metadataRepair: 'error', error: error instanceof Error ? error.message : String(error) });
        }
        this.phase(job.id, 'committing');
        await wt.commit('보완한 노트 메타데이터를 기록한다', author);
        await this.assertWritable(wt, job.userId, job.id);
        metadataIssues = await this.metadataIssues(wt);
        this.phase(job.id, 'editing', { metadataRepair: 'finished', metadataIssues });
      }
      const writtenCommits = await this.commits(wt);
      repository.markMerging(job.id, summary, writtenCommits);
      const activeWorktree = wt;
      await repo.withMergeLock(async () => {
        this.phase(job.id, 'merging');
        const previousMain = await repo.headSha();
        await this.assertWritable(activeWorktree, job.userId, job.id);
        const merge = await activeWorktree.mergeMain();
        if (!merge.ok) {
          const resolvingUser = this.users.getById(job.userId);
          if (!resolvingUser) throw new Error('Requesting user no longer exists');
          for (const path of merge.conflicts) this.acl.assertWrite(resolvingUser, path);
          repository.recordConflicts(job.id, merge.conflicts);
          this.phase(job.id, 'resolving_conflict', { files: merge.conflicts });
          await agent.resolveConflicts(activeWorktree, merge.conflicts, resolvingUser, { onUsage });
          await this.verifyResolution(activeWorktree, merge.conflicts);
          await activeWorktree.finishMerge(author);
        }
        const commits = await this.commits(activeWorktree);
        await this.assertWritable(activeWorktree, job.userId, job.id, previousMain);
        // Conflict resolution can alter metadata too; report final issues without another repair pass.
        metadataIssues = await this.metadataIssues(activeWorktree, previousMain);
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
      repository.checkpoints.delete(`job:${job.id}`);
    } catch (error) {
      // Preserve Dony's commits for diagnosis even if it threw before producing a summary.
      if (wt) {
        try {
          repository.recordCommits(job.id, await this.commits(wt));
          await wt.preserveFailed(job.id);
        } catch (commitError) {
          log.warn({ err: commitError, jobId: job.id }, 'Could not record failed write commits');
        }
      }
      repository.markFailed(job.id, error instanceof Error ? error.message : String(error), new Date().toISOString());
      log.error({ err: error, jobId: job.id, usage }, 'Write job failed');
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
      this.phase(job.id, result.status === 'succeeded' ? 'done' : 'failed', { usage, ...(metadataIssues.length ? { metadataIssues } : {}), ...(result.error ? { error: result.error } : {}) });
      if (result.status === 'succeeded') log.info({ jobId: job.id, mergeSha: result.mergeSha, usage, metadataIssues }, 'Write job completed');
    }
  }
}
