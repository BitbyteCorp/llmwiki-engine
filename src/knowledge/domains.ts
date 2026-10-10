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
