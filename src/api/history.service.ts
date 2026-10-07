import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { z } from 'zod';
import { AclService } from '../acl/acl.service.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { DB } from '../common/tokens.js';
import type { WriteJob } from '../jobs/write-job.types.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { notFound } from './api-error.js';
import type { historyQuerySchema, jobsQuerySchema } from './api.dto.js';
import { visibleCommit, visibleCompare, visibleLog } from './acl-history.js';

@Injectable()
export class HistoryService {
  constructor(
    @Inject(DB) private readonly db: Database.Database,
    private readonly repo: KnowledgeRepo,
    private readonly jobs: WriteJobsService,
    private readonly users: UsersService,
    private readonly acl: AclService,
  ) {}

  listCommits(query: z.infer<typeof historyQuerySchema>, user: User) {
    return visibleLog(this.repo, this.acl, user, { path: query.path, limit: query.limit, beforeSha: query.before, ...(query.follow ? { follow: true } : {}) });
  }

  async getCommit(sha: string, parent: number | undefined, user: User) {
    const policy = this.acl.policyKey(user);
    const detail = await visibleCommit(this.repo, this.acl, user, sha, parent);
    if (!detail) notFound('Commit not found');
    const row = this.db.prepare(`
      SELECT id FROM write_jobs
      WHERE merge_sha = ? OR EXISTS (
        SELECT 1 FROM json_each(write_jobs.commits) WHERE json_each.value = ?
      )
      ORDER BY created_at DESC LIMIT 1
    `).get(detail.commit.sha, detail.commit.sha) as { id: string } | undefined;
    const job = row ? this.jobs.get(row.id) : null;
    const visible = job && (user.role === 'admin' || job.userId === user.id) ? await this.jobs.visible(user, job) : null;
    if (this.acl.policyKey(user) !== policy) notFound('Permissions changed during history read');
    return { ...detail, job: visible };
  }

  compare(base: string, head: string, path: string | undefined, user: User) {
    return visibleCompare(this.repo, this.acl, user, base, head, path);
  }

  async assertRevert(user: User, sha: string, paths?: string[]) {
    const detail = await this.repo.show(sha);
    const files = detail.files.filter((file) => !paths || paths.some((path) => file.path === path || file.oldPath === path || file.path.startsWith(`${path}/`) || file.oldPath?.startsWith(`${path}/`)));
    for (const path of paths ?? []) this.acl.assertWrite(user, path);
    for (const file of files) {
      this.acl.assertWrite(user, file.path);
      if (file.oldPath) this.acl.assertWrite(user, file.oldPath);
    }
  }

  async listJobs(query: z.infer<typeof jobsQuerySchema>, user: User) {
    const policy = this.acl.policyKey(user);
    const jobs = this.jobs.list({ userId: user.role === 'admin' && !query.mine ? undefined : user.id, limit: query.limit, before: query.before });
    const visible = await Promise.all(jobs.map(async (job) => ({ ...await this.jobs.visible(user, job), user: this.requester(job) })));
    if (this.acl.policyKey(user) !== policy) notFound('Permissions changed during history read');
    return visible;
  }

  async getJob(id: string, user: User) {
    const policy = this.acl.policyKey(user);
    const job = this.jobs.get(id);
    if (!job || (user.role !== 'admin' && job.userId !== user.id)) notFound('Write job not found');
    const visible = await this.jobs.visible(user, job);
    const shas = [...new Set([...visible.commits, ...(visible.mergeSha ? [visible.mergeSha] : [])])];
    const details = await Promise.all(shas.map((sha) => visibleCommit(this.repo, this.acl, user, sha)));
    const commits = details.flatMap((detail) => detail ? [detail.commit] : []);
    const restricted = visible.input !== job.input || visible.summary !== job.summary || visible.error !== job.error || JSON.stringify(visible.commits) !== JSON.stringify(job.commits) || JSON.stringify(visible.conflicts) !== JSON.stringify(job.conflicts);
    const events = this.jobs.events(id).map((event) => restricted ? { ...event, detail: null } : event);
    if (this.acl.policyKey(user) !== policy) notFound('Permissions changed during history read');
    return { job: visible, user: this.requester(job), commits, events };
  }

  private requester(job: WriteJob) {
    const owner = this.users.getById(job.userId);
    return { email: owner?.email ?? 'deleted user', name: owner?.name ?? null };
  }
}
