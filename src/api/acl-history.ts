import type { AclService, AclUser } from '../acl/acl.service.js';
import type { CommitInfo, FileChange, KnowledgeRepo, LogOptions } from '../knowledge/repo.js';
import { notFound } from './api-error.js';

export function readableChanges(acl: AclService, user: AclUser, files: FileChange[]): FileChange[] {
  return files.filter((file) => acl.canRead(user, file.path) && (!file.oldPath || acl.canRead(user, file.oldPath)));
}

export function redactCommit(commit: CommitInfo): CommitInfo {
  return { ...commit, subject: 'Restricted change', body: '', trailers: {} };
}

function assertPolicy(acl: AclService, user: AclUser, key: string): void {
  if (acl.policyKey(user) !== key) notFound('Permissions changed during history read');
}

async function metadataRestricted(repo: KnowledgeRepo, acl: AclService, user: AclUser, commit: CommitInfo, selected: FileChange[], parent = 1): Promise<boolean> {
  if (user.role === 'admin') return false;
  if (readableChanges(acl, user, selected).length !== selected.length) return true;
  // Subject, body and trailers describe the whole merge, not its selected delta.
  for (let index = 0; index < commit.parents.length; index++) {
    if (index === parent - 1) continue;
    const changes = await repo.diffNames(commit.parents[index]!, commit.sha);
    if (readableChanges(acl, user, changes).length !== changes.length) return true;
  }
  return false;
}

/** SYSTEM callers use the repository directly; this helper always requires a reader. */
export async function visibleCommit(repo: KnowledgeRepo, acl: AclService, user: AclUser, sha: string, parent = 1) {
  const policy = acl.policyKey(user);
  const detail = await repo.show(sha, parent);
  const files = readableChanges(acl, user, detail.files);
  if (!files.length && (detail.files.length || user.role !== 'admin')) {
    assertPolicy(acl, user, policy);
    return null;
  }
  const restricted = await metadataRestricted(repo, acl, user, detail.commit, detail.files, parent);
  const patch = files.length === detail.files.length ? detail.patch
    : await repo.diffPatch(detail.commit.parents[parent - 1] ?? null, detail.commit.sha, [...new Set(files.flatMap((file) => file.oldPath ? [file.path, file.oldPath] : [file.path]))]);
  assertPolicy(acl, user, policy);
  return { commit: restricted ? redactCommit(detail.commit) : detail.commit, files, patch };
}

export async function visibleCompare(repo: KnowledgeRepo, acl: AclService, user: AclUser, base: string, head: string, path?: string) {
  const policy = acl.policyKey(user);
  if (path) acl.assertRead(user, path);
  // Discover all changes before selecting a path, so Git cannot disguise a rename
  // from a hidden source as an ordinary addition at a readable destination.
  const from = await repo.resolveRef(base);
  const to = await repo.resolveRef(head);
  const changes = await repo.diffNames(from, to);
  const files = readableChanges(acl, user, changes).filter((file) => !path || file.path === path || file.oldPath === path || file.path.startsWith(`${path}/`));
  const patch = await repo.diffPatch(from, to, [...new Set(files.flatMap((file) => file.oldPath ? [file.path, file.oldPath] : [file.path]))]);
  assertPolicy(acl, user, policy);
  return { base: from, head: to, files, patch };
}

export async function visibleLog(repo: KnowledgeRepo, acl: AclService, user: AclUser, options: LogOptions): Promise<CommitInfo[]> {
  const policy = acl.policyKey(user);
  if (options.path) acl.assertRead(user, options.path);
  const limit = options.limit === null ? null : options.limit ?? 50;
  if (limit === 0) return [];
  // Authorization precedes pagination, including rename-follow histories.
  const history = await repo.log({ ...options, limit: null });
  const result: CommitInfo[] = [];
  for (const commit of history) {
    if ((commit.path && !acl.canRead(user, commit.path)) || (commit.oldPath && !acl.canRead(user, commit.oldPath))) continue;
    const files = await repo.diffNames(commit.parents[0] ?? null, commit.sha);
    const readable = readableChanges(acl, user, files);
    if (!readable.length && (files.length || user.role !== 'admin')) continue;
    result.push(await metadataRestricted(repo, acl, user, commit, files) ? redactCommit(commit) : commit);
    if (result.length === limit) break;
  }
  assertPolicy(acl, user, policy);
  return result;
}

export async function visibleBlame(repo: KnowledgeRepo, acl: AclService, user: AclUser, path: string, ref = 'main') {
  const policy = acl.policyKey(user);
  acl.assertRead(user, path);
  const result = await repo.blame(path, ref);
  if (user.role === 'admin') {
    assertPolicy(acl, user, policy);
    return result;
  }
  const restricted = new Set<string>();
  for (const sha of new Set(result.ranges.map((range) => range.sha))) {
    const commit = (await repo.log({ ref: sha, limit: 1 }))[0]!;
    const changes = await repo.diffNames(commit.parents[0] ?? null, sha);
    if (await metadataRestricted(repo, acl, user, commit, changes)) restricted.add(sha);
  }
  assertPolicy(acl, user, policy);
  return { ...result, ranges: result.ranges.map((range) => restricted.has(range.sha)
    ? { start: range.start, end: range.end, sha: range.sha, authorName: range.authorName, date: range.date, summary: 'Restricted change' }
    : range) };
}
