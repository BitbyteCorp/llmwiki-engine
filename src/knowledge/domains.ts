import { posix } from 'node:path';

/** Top-level `wiki/` folders that hold cross-domain canonical notes instead of a domain. */
export const SHARED_WIKI_DIRS = ['concepts', 'entities'] as const;

export interface KnowledgeDomain {
  name: string;
  /** `wiki/<domain>/index.md`, the domain hub (MOC). */
  hubPath: string;
  /** `wiki/<domain>/AGENTS.md`, optional domain-only schema layered over root `AGENTS.md`. */
  schemaPath: string;
  hasHub: boolean;
  hasSchema: boolean;
}

/** Domain name for a repository path, or null for shared folders, root files, and non-wiki paths. */
export function domainOf(path: string): string | null {
  const dir = /^wiki\/([^/]+)\//.exec(path)?.[1];
  return dir && !(SHARED_WIKI_DIRS as readonly string[]).includes(dir) ? dir : null;
}

export function domainHubPath(domain: string): string {
  return `wiki/${domain}/index.md`;
}

export function domainSchemaPath(domain: string): string {
  return `wiki/${domain}/AGENTS.md`;
}

/** True for `wiki/<domain>/AGENTS.md`; these schema files get the same protection as root `AGENTS.md`. */
export function isDomainSchemaPath(path: string): boolean {
  const domain = domainOf(path);
  return domain !== null && path === domainSchemaPath(domain);
}

/** Markdown notes placed directly under `wiki/` without a domain or shared folder. */
export function isUnclassifiedWikiNote(path: string): boolean {
  return posix.dirname(path) === 'wiki' && /\.md$/i.test(path);
}

/** Domain notes need a subject folder; domain hubs and schemas are not ordinary notes. */
export function isShallowDomainNote(path: string): boolean {
  if (!/\.md$/i.test(path) || isUnclassifiedWikiNote(path) || isDomainSchemaPath(path)) return false;
  const domain = domainOf(path);
  return domain !== null && posix.dirname(path) === `wiki/${domain}` && path !== domainHubPath(domain);
}

/** Domains allow topic/subtopic folders; shared canonical notes allow at most one topic. */
export function isTooDeepWikiNote(path: string): boolean {
  if (!path.startsWith('wiki/') || !/\.md$/i.test(path) || isUnclassifiedWikiNote(path) || isDomainSchemaPath(path)) return false;
  const domain = domainOf(path);
  if (domain !== null && path === domainHubPath(domain)) return false;
  const folderDepth = path.split('/').length - 2;
  return folderDepth > (domain === null ? 2 : 3);
}

/** Tracked files of any type imply every ancestor folder below `wiki/`. */
export function wikiFolderPaths(paths: Iterable<string>): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith('wiki/')) continue;
    const parts = path.split('/');
    for (let depth = 2; depth < parts.length; depth++) {
      folders.add(`${parts.slice(0, depth).join('/')}/`);
    }
  }
  return [...folders].sort();
}

/** Only mechanically recognizable naming violations belong here; subject choice needs judgment. */
export function invalidWikiFolderNameReason(name: string): string | null {
  if (/^(?:batch|part|chunk)-?\d+$/.test(name)) return '배치·분할 번호는 주제 폴더 이름으로 사용하지 않는다';
  if (/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(name)) return '날짜는 주제 폴더 이름으로 사용하지 않는다';
  if (name.length < 2 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return '폴더 이름은 두 글자 이상의 ASCII 소문자 kebab-case여야 한다';
  }
  return null;
}

/** Domains derived from tracked repository paths, sorted by name. */
export function listDomains(paths: Iterable<string>): KnowledgeDomain[] {
  const present = new Set<string>();
  const names = new Set<string>();
  for (const path of paths) {
    present.add(path);
    const domain = domainOf(path);
    if (domain) names.add(domain);
  }
  return [...names].sort().map((name) => {
    const hubPath = domainHubPath(name);
    const schemaPath = domainSchemaPath(name);
    return { name, hubPath, schemaPath, hasHub: present.has(hubPath), hasSchema: present.has(schemaPath) };
  });
}
