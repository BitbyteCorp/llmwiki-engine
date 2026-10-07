import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Logger } from 'pino';
import { UsersService } from '../auth/users.service.js';
import { LOGGER } from '../common/tokens.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import { LunaService } from '../luna/luna.service.js';
import { IndexerService } from '../rag/indexer.service.js';
import type { WriteJob } from './write-job.types.js';
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
  ) {}

  submit(input: { userId: number; input: string }): WriteJob {
    const id = randomUUID();
    this.repository.enqueue(id, input.userId, input.input, new Date().toISOString());
    const job = this.get(id)!;
    this.kick();
    return job;
  }

  get(id: string): WriteJob | null {
    return this.repository.get(id);
  }

  list(opts: { userId?: number; limit?: number; before?: string } = {}): WriteJob[] {
    return this.repository.list(opts);
  }

  start(): void {
    if (this.enabled) return;
    this.repository.failInterrupted(
      'Engine restarted before the write job completed; submit a new write request.',
      new Date().toISOString(),
    );
    this.enabled = true;
    this.kick();
  }

  async stop(): Promise<void> {
    this.enabled = false;
    await this.worker;
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
    try {
      const user = this.users.getById(job.userId);
      if (!user) throw new Error(`Requesting user ${job.userId} no longer exists`);
      const author = { name: user.name || user.email, email: user.email };
      wt = await repo.createWorktree(job.id);
      const { summary } = await luna.runWrite(this.get(job.id)!, wt, author);
      const subject = summary.trim().split(/\r?\n/, 1)[0]?.slice(0, 200) || 'Update knowledge';
      await wt.commit(subject, author);
      const writtenCommits = await this.commits(wt);
      repository.markMerging(job.id, summary, writtenCommits);
      const activeWorktree = wt;
      await repo.withMergeLock(async () => {
        const merge = await activeWorktree.mergeMain();
        if (!merge.ok) {
          await luna.resolveConflicts(activeWorktree, merge.conflicts);
          await this.verifyResolution(activeWorktree, merge.conflicts);
          await activeWorktree.finishMerge(author);
        }
        const commits = await this.commits(activeWorktree);
        const mergeSha = await activeWorktree.fastForwardMain();
        repository.recordMerge(job.id, commits, mergeSha);
        try {
          await indexer.syncToHead();
        } catch (error) {
          log.error({ err: error, jobId: job.id, mergeSha }, 'Write merged but indexing failed');
        }
      });
      repository.markSucceeded(job.id, new Date().toISOString());
    } catch (error) {
      // Preserve Luna's commits for diagnosis even if it threw before producing a summary.
      if (wt) {
        try {
          repository.recordCommits(job.id, await this.commits(wt));
        } catch (commitError) {
          log.warn({ err: commitError, jobId: job.id }, 'Could not record failed write commits');
        }
      }
      repository.markFailed(job.id, error instanceof Error ? error.message : String(error), new Date().toISOString());
      log.error({ err: error, jobId: job.id }, 'Write job failed');
    } finally {
      if (wt) {
        try {
          await wt.dispose();
        } catch (error) {
          // Cleanup does not invalidate an already-merged job; open prunes leftovers on boot.
          log.warn({ err: error, jobId: job.id }, 'Could not dispose write worktree');
        }
      }
    }
  }
}
