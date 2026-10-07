import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { AppContext } from '../context.js';
import type { Worktree } from '../knowledge/repo.js';

const execFileAsync = promisify(execFile);

export interface WriteJob {
  id: string; userId: number; source: 'mcp' | 'dreaming'; input: string;
  status: 'queued' | 'running' | 'merging' | 'succeeded' | 'failed';
  summary: string | null; commits: string[]; mergeSha: string | null; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

interface JobRow {
  id: string; user_id: number; source: WriteJob['source']; input: string;
  status: WriteJob['status']; summary: string | null; commits: string;
  merge_sha: string | null; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}

function toJob(row: JobRow): WriteJob {
  return {
    id: row.id, userId: row.user_id, source: row.source, input: row.input,
    status: row.status, summary: row.summary, commits: JSON.parse(row.commits) as string[],
    mergeSha: row.merge_sha, error: row.error, createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

export class WriteJobService {
  private enabled = false;
  private worker: Promise<void> | null = null;

  constructor(private readonly ctx: AppContext) {}

  submit(input: { userId: number; input: string }): WriteJob {
    const id = randomUUID();
    this.ctx.db.prepare(`
      INSERT INTO write_jobs (id, user_id, source, input, status, created_at)
      VALUES (?, ?, 'mcp', ?, 'queued', ?)
    `).run(id, input.userId, input.input, new Date().toISOString());
    const job = this.get(id)!;
    this.kick();
    return job;
  }

  get(id: string): WriteJob | null {
    const row = this.ctx.db.prepare('SELECT * FROM write_jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  list(opts: { userId?: number; limit?: number; before?: string } = {}): WriteJob[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.userId !== undefined) {
      clauses.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts.before) {
      const cursor = this.get(opts.before);
      if (cursor) {
        clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      } else {
        clauses.push('created_at < ?');
        params.push(opts.before);
      }
    }
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(200, Math.trunc(opts.limit!))) : 50;
    params.push(limit);
    const rows = this.ctx.db.prepare(`
      SELECT * FROM write_jobs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...params) as JobRow[];
    return rows.map(toJob);
  }

  start(): void {
    if (this.enabled) return;
    this.ctx.db.prepare(`
      UPDATE write_jobs SET status = 'failed', error = ?, finished_at = ?
      WHERE status IN ('running', 'merging')
    `).run('Engine restarted before the write job completed; submit a new write request.', new Date().toISOString());
    this.enabled = true;
    this.kick();
  }

  async stop(): Promise<void> {
    this.enabled = false;
    await this.worker;
  }

  private kick(): void {
    if (!this.enabled || this.worker) return;
    // Deferring preserves submit's immediate queued response.
    this.worker = Promise.resolve().then(() => this.drain()).catch((error: unknown) => {
      this.ctx.log.error({ err: error }, 'Write job worker stopped unexpectedly');
      this.enabled = false;
    }).finally(() => {
      this.worker = null;
      // submit may enqueue between drain's final query and this continuation.
      if (this.enabled && this.next()) this.kick();
    });
  }

  private next(): WriteJob | null {
    const row = this.ctx.db.prepare(`
      SELECT * FROM write_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1
    `).get() as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  private async drain(): Promise<void> {
    while (this.enabled) {
      const job = this.next();
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
    const { db, repo, luna, indexer, log } = this.ctx;
    let wt: Worktree | undefined;
    db.prepare("UPDATE write_jobs SET status = 'running', started_at = ? WHERE id = ?")
      .run(new Date().toISOString(), job.id);
    try {
      const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(job.userId) as
        { name: string | null; email: string } | undefined;
      if (!user) throw new Error(`Requesting user ${job.userId} no longer exists`);
      const author = { name: user.name || user.email, email: user.email };
      wt = await repo.createWorktree(job.id);
      const { summary } = await luna.runWrite(this.get(job.id)!, wt, author);
      const subject = summary.trim().split(/\r?\n/, 1)[0]?.slice(0, 200) || 'Update knowledge';
      await wt.commit(subject, author);
      const writtenCommits = await this.commits(wt);
      db.prepare("UPDATE write_jobs SET summary = ?, commits = ?, status = 'merging' WHERE id = ?")
        .run(summary, JSON.stringify(writtenCommits), job.id);
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
        db.prepare('UPDATE write_jobs SET commits = ?, merge_sha = ? WHERE id = ?')
          .run(JSON.stringify(commits), mergeSha, job.id);
        try {
          await indexer.syncToHead();
        } catch (error) {
          log.error({ err: error, jobId: job.id, mergeSha }, 'Write merged but indexing failed');
        }
      });
      db.prepare("UPDATE write_jobs SET status = 'succeeded', finished_at = ? WHERE id = ?")
        .run(new Date().toISOString(), job.id);
    } catch (error) {
      // Preserve Luna's commits for diagnosis even if it threw before producing a summary.
      if (wt) {
        try {
          db.prepare('UPDATE write_jobs SET commits = ? WHERE id = ?')
            .run(JSON.stringify(await this.commits(wt)), job.id);
        } catch (commitError) {
          log.warn({ err: commitError, jobId: job.id }, 'Could not record failed write commits');
        }
      }
      db.prepare("UPDATE write_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run(error instanceof Error ? error.message : String(error), new Date().toISOString(), job.id);
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
