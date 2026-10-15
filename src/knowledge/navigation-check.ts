import { posix } from 'node:path';
import matter from 'gray-matter';
import {
  domainHubPath, domainOf, invalidWikiFolderNameReason, isDomainSchemaPath,
  isShallowDomainNote, isTooDeepWikiNote, isUnclassifiedWikiNote, listDomains, wikiFolderPaths,
} from './domains.js';
import { MEMORY_PATH, memoryIssues } from './memory.js';
import { aliasesFromFrontmatter, wikilinkTargets } from '../rag/chunking.js';
import { NoteTargetResolver } from '../rag/link-resolver.js';

export interface NavigationIssue {
  path: string;
  kind: 'unclassified' | 'shallow' | 'too-deep' | 'folder-name' | 'missing-hub' | 'hub-unlinked' | 'orphan' | 'broken-link' | 'memory';
  message: string;
}

function wikiNote(path: string): boolean {
  return path.startsWith('wiki/') && /\.md$/i.test(path) && !isDomainSchemaPath(path);
}

/** Inspect a complete worktree snapshot, reporting only the changed scope and its entry points. */
export function navigationIssues(input: { files: Map<string, string>; changed: string[] }): NavigationIssue[] {
  const { files } = input;
  const changed = new Set(input.changed);
  if (!changed.size) return [];
  const issues: NavigationIssue[] = [];
  const add = (path: string, kind: NavigationIssue['kind'], message: string) => issues.push({ path, kind, message });
  const paths = [...files.keys()].sort();
  const notePaths = paths.filter(path => /\.md$/i.test(path));
  const aliases = new Map<string, readonly string[]>();
  for (const path of notePaths) {
    try {
      const names = aliasesFromFrontmatter(matter(files.get(path)!, {}).data.aliases);
      if (names.length) aliases.set(path, names);
    } catch {
      // Invalid frontmatter is handled by metadata validation; links still need inspection.
    }
  }
  const noteResolver = new NoteTargetResolver(notePaths, aliases);
  const fileResolver = new NoteTargetResolver(paths);
  const incoming = new Set<string>();
  for (const path of notePaths) {
    if (!wikiNote(path)) continue;
    for (const { text } of wikilinkTargets(files.get(path)!)) {
      const target = noteResolver.resolve(text).path;
      if (target !== null && target !== path && wikiNote(target)) incoming.add(target);
    }
  }
  const rootTargets = new Set(wikilinkTargets(files.get('index.md') ?? '')
    .map(({ text }) => noteResolver.resolve(text).path).filter(path => path !== null));
  // The root index may link shared canonical notes directly; that is a curated discovery path too.
  for (const target of rootTargets) if (wikiNote(target)) incoming.add(target);
  const changedDomains = new Set(input.changed.map(domainOf).filter(domain => domain !== null));
  for (const domain of listDomains(paths)) {
    if (!changed.has('index.md') && !changedDomains.has(domain.name)) continue;
    if (!domain.hasHub) add(domain.hubPath, 'missing-hub', '도메인 진입점인 허브가 없다.');
    else if (!rootTargets.has(domain.hubPath)) add(domain.hubPath, 'hub-unlinked', '루트 index.md에서 도메인 허브를 위키링크로 연결해야 한다.');
  }
  const changedExisting = input.changed.filter(path => files.has(path)).sort();
  for (const path of wikiFolderPaths(changedExisting)) {
    const reason = invalidWikiFolderNameReason(posix.basename(path));
    if (reason !== null) add(path, 'folder-name', reason);
  }
  for (const path of changedExisting) {
    if (wikiNote(path)) {
      if (isUnclassifiedWikiNote(path)) add(path, 'unclassified', '미분류 노트를 도메인 또는 공유 영역에 배치해야 한다.');
      if (isShallowDomainNote(path)) add(path, 'shallow', '일반 도메인 노트는 안정적인 주제 폴더 안에 배치해야 한다.');
      if (isTooDeepWikiNote(path)) add(path, 'too-deep', '허용한 주제 깊이를 넘은 노트의 배치를 정리해야 한다.');
      const domain = domainOf(path);
      const isHub = domain !== null && path === domainHubPath(domain);
      if (!isHub && !incoming.has(path)) add(path, 'orphan', '루트 index.md나 다른 위키 노트·허브에서 들어오는 위키링크가 없다.');
    }
    if (!/\.md$/i.test(path)) continue;
    for (const { text } of wikilinkTargets(files.get(path)!)) {
      const extension = posix.extname(text).toLowerCase();
      const target = (extension && extension !== '.md' ? fileResolver : noteResolver).resolve(text);
      if (target.path !== null) continue;
      add(path, 'broken-link', target.candidates.length > 1
        ? `위키링크 [[${text}]]의 대상이 모호하다. 경로가 있는 위키링크로 구분해야 한다.`
        : `위키링크 [[${text}]]의 대상이 없다.`);
    }
  }
  if (changed.has(MEMORY_PATH)) {
    for (const message of memoryIssues(files.get(MEMORY_PATH) ?? '')) add(MEMORY_PATH, 'memory', message);
  }
  return issues;
}
