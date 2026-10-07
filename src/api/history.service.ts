import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { z } from 'zod';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { DB } from '../common/tokens.js';
import type { WriteJob } from '../jobs/write-job.types.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { notFound } from './api-error.js';
import type { historyQuerySchema, jobsQuerySchema } from './api.dto.js';

@Injectable()
export class HistoryService {
  constructor(
    @Inject(DB) private readonly db: Database.Database,
    private readonly repo: KnowledgeRepo,
    private readonly jobs: WriteJobsService,
    private readonly users: UsersService,
  ) {}

  listCommits(query: z.infer<typeof historyQuerySchema>) {
    return this.repo.log({ path: query.path, limit: query.limit, beforeSha: query.before, ...(query.follow ? { follow: true } : {}) });
  }

  async getCommit(sha: string, parent?: number, user?: User) {
    const detail = await this.repo.show(sha, parent);
    const row = this.db.prepare(`
      SELECT id FROM write_jobs
      WHERE merge_sha = ? OR EXISTS (
        SELECT 1 FROM json_each(write_jobs.commits) WHERE json_each.value = ?
      )
      ORDER BY created_at DESC LIMIT 1
    `).get(detail.commit.sha, detail.commit.sha) as { id: string } | undefined;
    const job = row ? this.jobs.get(row.id) : null;
    const visible = job && (!user || user.role === 'admin' || job.userId === user.id) ? job : null;
    return { ...detail, job: visible };
  }

  listJobs(query: z.infer<typeof jobsQuerySchema>, user: User) {
    const jobs = this.jobs.list({ userId: user.role === 'admin' && !query.mine ? undefined : user.id, limit: query.limit, before: query.before });
    return jobs.map((job) => ({ ...job, user: this.requester(job) }));
  }

  async getJob(id: string, user: User) {
    const job = this.jobs.get(id);
    if (!job || (user.role !== 'admin' && job.userId !== user.id)) notFound('Write job not found');
    const shas = [...new Set([...job.commits, ...(job.mergeSha ? [job.mergeSha] : [])])];
    const commits = await Promise.all(shas.map(async (sha) => (await this.repo.log({ ref: sha, limit: 1 }))[0]!));
    return { job, user: this.requester(job), commits, events: this.jobs.events(id) };
  }

  private requester(job: WriteJob) {
    const owner = this.users.getById(job.userId);
    return { email: owner?.email ?? 'deleted user', name: owner?.name ?? null };
  }
}
