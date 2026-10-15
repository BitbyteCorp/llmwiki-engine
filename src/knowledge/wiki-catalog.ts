import { Injectable } from '@nestjs/common';
import { posix } from 'node:path';
import matter from 'gray-matter';
import { AclService, type AclUser } from '../acl/acl.service.js';
import { KnowledgeRepo } from './repo.js';
import { domainHubPath, isDomainSchemaPath, SHARED_WIKI_DIRS } from './domains.js';

export interface WikiCatalogNote {
  path: string;
  title: string;
  description: string;
  type: string;
}

/** Whole outline, including its omission footer, measured in Unicode code points. */
export const WIKI_OUTLINE_BUDGET_CHARS = 6_000;
export const WIKI_OUTLINE_FIELD_CHARS = 120;

function singleLine(value: string): string {
  return value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
}

function quoted(value: string, bounded = true): string {
  const chars = Array.from(singleLine(value));
  const text = bounded && chars.length > WIKI_OUTLINE_FIELD_CHARS
    ? `${chars.slice(0, WIKI_OUTLINE_FIELD_CHARS - 1).join('')}…` : chars.join('');
  return JSON.stringify(text).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function folderPrefix(folder = 'wiki/'): string {
  if (folder.startsWith('/') || /[\\\u0000-\u001f]/u.test(folder)
    || folder.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('위키 폴더 경로가 올바르지 않다.');
  }
  const normalized = folder.split('/').filter(part => part && part !== '.').join('/');
  if (normalized !== 'wiki' && !normalized.startsWith('wiki/')) throw new Error('wiki/ 아래 폴더를 지정한다.');
  return `${normalized}/`;
}

function metadata(path: string, content: string): WikiCatalogNote {
  let body = content;
  let data: Record<string, unknown> = {};
  try {
    const parsed = matter(content);
    body = parsed.content;
    data = parsed.data;
  } catch {
    // Invalid frontmatter must not make an existing note disappear from navigation.
  }
  const title = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1] ?? posix.basename(path).replace(/\.md$/i, '');
  return {
    path, title: singleLine(title),
    description: typeof data.description === 'string' ? singleLine(data.description) : '',
    type: typeof data.type === 'string' ? singleLine(data.type) : '',
  };
}

/** Complete main-ref inventory; only source metadata, never user projections, is cached. */
@Injectable()
export class WikiCatalog {
  private snapshot?: { sha: string; value: Promise<WikiCatalogNote[]> };

  constructor(private readonly repo: KnowledgeRepo, private readonly acl: AclService) {}

  private async current(): Promise<WikiCatalogNote[]> {
    const sha = await this.repo.headSha();
    if (this.snapshot?.sha === sha) return this.snapshot.value;
    const value = (async () => {
      const paths = (await this.repo.listFiles('wiki/', sha))
        .filter(path => path.startsWith('wiki/') && /\.md$/i.test(path)).sort();
      const notes: WikiCatalogNote[] = [];
      // Bound concurrent Git reads while keeping every read pinned to the same main SHA.
      for (let offset = 0; offset < paths.length; offset += 32) {
        const batch = await Promise.all(paths.slice(offset, offset + 32).map(async path => {
          const content = await this.repo.readFile(path, sha);
          return content === null ? null : metadata(path, content);
        }));
        for (const note of batch) if (note) notes.push(note);
      }
      return notes;
    })();
    this.snapshot = { sha, value };
    void value.catch(() => { if (this.snapshot?.value === value) this.snapshot = undefined; });
    return value;
  }

  private project(notes: WikiCatalogNote[], user?: AclUser, folder?: string): WikiCatalogNote[] {
    const prefix = folderPrefix(folder);
    // No policy snapshot crosses an await: changes during Git reads apply to this response.
    const readable = user ? this.acl.readPredicate(user) : () => true;
    return notes.filter(note => {
      if (!note.path.startsWith(prefix) || !readable(note.path)) return false;
      const parts = note.path.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        if (!readable(`${parts.slice(0, depth).join('/')}/`)) return false;
      }
      return true;
    }).map(note => ({ ...note }));
  }

  async notes(user?: AclUser, folder?: string): Promise<WikiCatalogNote[]> {
    return this.project(await this.current(), user, folder);
  }

  async outline(user?: AclUser): Promise<string> {
    const notes = this.project(await this.current(), user);
    const areas = new Map<string, WikiCatalogNote[]>();
    let unclassified = 0;
    for (const note of notes) {
      const parts = note.path.split('/');
      if (parts.length === 2) { unclassified++; continue; }
      const members = areas.get(parts[1]!) ?? [];
      members.push(note);
      areas.set(parts[1]!, members);
    }
    const entries: string[] = [];
    for (const [name, members] of [...areas].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const folder = `wiki/${name}/`;
      if ((SHARED_WIKI_DIRS as readonly string[]).includes(name)) {
        entries.push(`- shared: ${quoted(name)}; folder: ${quoted(folder, false)}; notes: ${members.length}`);
        for (const note of members) {
          entries.push(`  - ${quoted(note.title)} — ${quoted(note.description)}; path: ${quoted(note.path, false)}`);
        }
        continue;
      }
      const hub = members.find(note => note.path === domainHubPath(name));
      const ordinary = members.filter(note => note !== hub && !isDomainSchemaPath(note.path));
      const topics = new Map<string, number>();
      let shallow = 0;
      for (const note of ordinary) {
        const parts = note.path.slice(folder.length).split('/');
        if (parts.length === 1) shallow++;
        else topics.set(parts[0]!, (topics.get(parts[0]!) ?? 0) + 1);
      }
      entries.push(`- domain: ${quoted(name)}; hub: ${hub ? quoted(hub.path, false) : 'none'}; description: ${quoted(hub?.description ?? '')}; notes: ${ordinary.length}; without-topic: ${shallow}`);
      for (const [topic, count] of [...topics].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
        entries.push(`  - topic: ${quoted(topic)}; folder: ${quoted(`${folder}${topic}/`, false)}; notes: ${count}`);
      }
    }
    if (unclassified) entries.push(`- unclassified: ${unclassified}; folder: "wiki/"`);
    if (!entries.length) return '읽을 수 있는 위키 노트가 없다. listing("wiki/"), MCP browse({folder:"wiki/"}) 또는 도니 browse_catalog({folder:"wiki/"})로 전체 목차를 조회한다.';
    const footer = (omitted: number) => `항목 ${omitted}개 생략. 전체 목차는 listing("wiki/"), MCP browse({folder:"wiki/"}) 또는 도니 browse_catalog({folder:"wiki/"})로 조회하고 도메인·주제 폴더로 범위를 좁힌다.`;
    const selected: string[] = [];
    let length = 0;
    for (const entry of entries) {
      const cost = Array.from(entry).length + 1;
      if (length + cost + Array.from(footer(entries.length - selected.length)).length > WIKI_OUTLINE_BUDGET_CHARS) break;
      selected.push(entry);
      length += cost;
    }
    return [...selected, footer(entries.length - selected.length)].join('\n');
  }

  async listing(folder: string, user?: AclUser): Promise<string> {
    const notes = this.project(await this.current(), user, folder);
    return notes.map(note => {
      const title = note.title.replace(/[\\[\]]/g, '\\$&');
      const path = note.path.split('/').map(encodeURIComponent).join('/');
      return `- [${title}](${path}) (${note.type}): ${note.description}`;
    }).join('\n');
  }
}
