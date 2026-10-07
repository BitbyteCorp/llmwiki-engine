import type { AclService, AclUser } from '../acl/acl.service.js';
import type { CommitInfo, FileChange, KnowledgeRepo, LogOptions } from '../knowledge/repo.js';

export function readableChanges(acl: AclService, user: AclUser, files: FileChange[]): FileChange[] {
  return files.filter((file) => acl.canRead(user, file.path) && (!file.oldPath || acl.canRead(user, file.oldPath)));
}

export function redactCommit(commit: CommitInfo): CommitInfo {
  return { ...commit, subject: 'Restricted change', body: '', trailers: {} };
}

/** SYSTEM callers use the repository directly; this helper always requires a reader. */
export async function visibleCommit(repo: KnowledgeRepo, acl: AclService, user: AclUser, sha: string, parent = 1) {
  const detail = await repo.show(sha, parent);
  const files = readableChanges(acl, user, detail.files);
  if (!files.length && detail.files.length) return null;
  if (!files.length && user.role !== 'admin') return null;
  if (files.length === detail.files.length) return detail;
  return {
    commit: redactCommit(detail.commit), files,
    patch: await repo.diffPatch(detail.commit.parents[parent - 1] ?? null, detail.commit.sha, [...new Set(files.flatMap((file) => file.oldPath ? [file.path, file.oldPath] : [file.path]))]),
  };
}

export async function visibleCompare(repo: KnowledgeRepo, acl: AclService, user: AclUser, base: string, head: string, path?: string) {
  if (path) acl.assertRead(user, path);
  // Discover all changes before selecting a path, so Git cannot disguise a rename
  // from a hidden source as an ordinary addition at a readable destination.
  const from = await repo.resolveRef(base);
  const to = await repo.resolveRef(head);
  const changes = await repo.diffNames(from, to);
  const files = readableChanges(acl, user, changes).filter((file) => !path || file.path === path || file.oldPath === path || file.path.startsWith(`${path}/`));
  return { base: from, head: to, files, patch: await repo.diffPatch(from, to, [...new Set(files.flatMap((file) => file.oldPath ? [file.path, file.oldPath] : [file.path]))]) };
}

export async function visibleLog(repo: KnowledgeRepo, acl: AclService, user: AclUser, options: LogOptions): Promise<CommitInfo[]> {
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
    result.push(readable.length === files.length ? commit : redactCommit(commit));
    if (result.length === limit) break;
  }
  return result;
}

export async function visibleBlame(repo: KnowledgeRepo, acl: AclService, user: AclUser, path: string, ref = 'main') {
  acl.assertRead(user, path);
  const result = await repo.blame(path, ref);
  if (user.role === 'admin') return result;
  const restricted = new Set<string>();
  for (const sha of new Set(result.ranges.map((range) => range.sha))) {
    const commit = (await repo.log({ ref: sha, limit: 1 }))[0]!;
    const changes = await repo.diffNames(commit.parents[0] ?? null, sha);
    if (readableChanges(acl, user, changes).length !== changes.length) restricted.add(sha);
  }
  return { ...result, ranges: result.ranges.map((range) => restricted.has(range.sha)
    ? { start: range.start, end: range.end, sha: range.sha, authorName: range.authorName, date: range.date, summary: 'Restricted change' }
    : range) };
}
