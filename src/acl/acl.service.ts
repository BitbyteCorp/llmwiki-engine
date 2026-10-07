import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { aclCreateSchema, aclPrefixSchema } from '../api/api.dto.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../auth/users.service.js';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { Access, AclExplanation, AclRule, AclUser } from './acl.types.js';

export type { Access, AclExplanation, AclRule, AclUser } from './acl.types.js';

const ruleColumns = 'id, prefix, subject_type AS subjectType, subject, access, created_by AS createdBy, created_at AS createdAt';
const priority = { user: 3, role: 2, everyone: 1 };

function fail(status: number, code: string, message: string): never {
  throw new HttpException({ error: { code, message } }, status);
}

@Injectable()
export class AclService {
  private readonly readRevision;
  private readonly readRules;
  private cachedRevision = -1;
  private cachedRules: AclRule[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {
    this.readRevision = db.prepare('SELECT revision FROM acl_policy WHERE id = 1');
    this.readRules = db.prepare(`SELECT ${ruleColumns} FROM acl_rules`);
  }

  get revision(): number {
    const row = this.readRevision.get() as { revision: number };
    return row.revision;
  }

  policyKey(user: AclUser): string {
    return `acl:${this.revision}:${user.id}:${user.role}`;
  }

  list(): AclRule[] {
    return this.rules().map((rule) => ({ ...rule }));
  }

  access(user: AclUser, path: string): Access {
    this.validatePath(path);
    if (user.role === 'admin') return 'write';
    return this.effective(user, this.match(user, path));
  }

  canRead(user: AclUser, path: string): boolean {
    return this.access(user, path) !== 'none';
  }

  canWrite(user: AclUser, path: string): boolean {
    return this.access(user, path) === 'write';
  }

  filterPaths(user: AclUser, paths: string[]): string[] {
    return paths.filter((path) => this.canRead(user, path));
  }

  assertRead(user: AclUser, path: string): void {
    if (!this.canRead(user, path)) fail(404, 'not_found', 'Not found.');
  }

  assertWrite(user: AclUser, path: string): void {
    const access = this.access(user, path);
    if (access === 'none') fail(404, 'not_found', 'Not found.');
    if (access !== 'write') fail(403, 'forbidden', 'Forbidden.');
  }

  explain(user: AclUser, path: string): AclExplanation {
    this.validatePath(path);
    const rule = user.role === 'admin' ? null : this.match(user, path);
    return {
      userId: user.id, path, access: user.role === 'admin' ? 'write' : this.effective(user, rule),
      rule: rule ? { ...rule } : null,
      reason: user.role === 'admin' ? 'admin' : rule ? 'rule' : 'role_default',
    };
  }

  /** A read predicate for repository path columns, applied before ORDER BY/LIMIT. */
  sql(user: AclUser, column = 'path'): { sql: string; params: Array<string | number> } {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(column)) {
      throw new Error('Expected a SQL path column identifier');
    }
    if (user.role === 'admin') return { sql: '1 = 1', params: [] };
    return {
      sql: `COALESCE((SELECT acl.access FROM acl_rules AS acl
        WHERE ((acl.subject_type = 'user' AND acl.subject = ?)
          OR (acl.subject_type = 'role' AND acl.subject = ?)
          OR acl.subject_type = 'everyone')
          AND (acl.prefix = '/' OR acl.prefix = ${column}
            OR (substr(acl.prefix, -1) = '/' AND substr(${column}, 1, length(acl.prefix)) = acl.prefix))
        ORDER BY CASE WHEN acl.prefix = '/' THEN 0 ELSE length(acl.prefix) END DESC,
          CASE acl.subject_type WHEN 'user' THEN 3 WHEN 'role' THEN 2 ELSE 1 END DESC
        LIMIT 1), 'read') <> 'none'`,
      params: [String(user.id), user.role],
    };
  }

  create(input: z.input<typeof aclCreateSchema>, actor: AclUser): AclRule {
    if (actor.role !== 'admin') fail(403, 'forbidden', 'Forbidden.');
    const parsed = aclCreateSchema.safeParse(input);
    if (!parsed.success) fail(400, 'invalid_request', parsed.error.issues.map((issue) => issue.message).join('; '));
    const value = parsed.data;
    if (value.subjectType === 'user' && !this.users.getById(Number(value.subject))) {
      fail(400, 'invalid_request', 'Unknown ACL user subject.');
    }
    const rule = this.db.transaction(() => {
      const previous = this.db.prepare('SELECT id FROM acl_rules WHERE prefix = ? AND subject_type = ? AND subject = ?')
        .get(value.prefix, value.subjectType, value.subject) as { id: number } | undefined;
      const result = this.db.prepare(`INSERT INTO acl_rules (prefix, subject_type, subject, access, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(prefix, subject_type, subject) DO UPDATE SET access = excluded.access
        RETURNING ${ruleColumns}`).get(value.prefix, value.subjectType, value.subject, value.access, actor.id, new Date().toISOString()) as AclRule;
      this.audit.record({ actorId: actor.id, action: previous ? 'acl.update' : 'acl.create', target: `acl:${result.id}`, outcome: 'success' });
      return result;
    }).immediate();
    this.cachedRevision = -1;
    return rule;
  }

  delete(id: number, actor: AclUser): void {
    if (actor.role !== 'admin') fail(403, 'forbidden', 'Forbidden.');
    this.db.transaction(() => {
      const result = this.db.prepare('DELETE FROM acl_rules WHERE id = ?').run(id);
      if (!result.changes) fail(404, 'not_found', 'Not found.');
      this.audit.record({ actorId: actor.id, action: 'acl.delete', target: `acl:${id}`, outcome: 'success' });
    }).immediate();
    this.cachedRevision = -1;
  }

  private validatePath(path: string): void {
    if (!aclPrefixSchema.safeParse(path).success) fail(400, 'invalid_request', 'Expected a safe repository-relative path.');
  }

  private rules(): AclRule[] {
    const revision = this.revision;
    if (this.cachedRevision !== revision) {
      this.cachedRules = (this.readRules.all() as AclRule[]).sort((a, b) =>
        (b.prefix === '/' ? 0 : b.prefix.length) - (a.prefix === '/' ? 0 : a.prefix.length) ||
        priority[b.subjectType] - priority[a.subjectType]);
      this.cachedRevision = revision;
    }
    return this.cachedRules;
  }

  private match(user: AclUser, path: string): AclRule | null {
    const subject = String(user.id);
    return this.rules().find((rule) =>
      (rule.subjectType === 'everyone' || (rule.subjectType === 'role' ? rule.subject === user.role : rule.subject === subject)) &&
      (rule.prefix === '/' || rule.prefix === path || (rule.prefix.endsWith('/') && path.startsWith(rule.prefix)))) ?? null;
  }

  private effective(user: AclUser, rule: AclRule | null): Access {
    const access = rule?.access ?? (user.role === 'viewer' ? 'read' : 'write');
    return user.role === 'viewer' && access === 'write' ? 'read' : access;
  }
}
