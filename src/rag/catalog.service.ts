import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { DB } from '../common/tokens.js';
import { AclService, type AclUser } from '../acl/acl.service.js';
import { normalizeTag } from './chunking.js';
import { NoteTargetResolver } from './link-resolver.js';

export interface NoteSummary {
  path: string;
  title: string;
}

export interface CatalogLinks {
  outgoing: NoteSummary[];
  backlinks: NoteSummary[];
  unresolved: string[];
}

export interface CatalogGraph {
  nodes: Array<NoteSummary & { tags: string[] }>;
  edges: Array<{ from: string; to: string }>;
}

export interface TagFacet {
  tag: string;
  count: number;
}

interface CatalogNote extends NoteSummary { tags_json: string }
interface IndexedLink { source_path: string; target_name: string; target_text: string; target_path: string | null }

@Injectable()
export class CatalogService {
  constructor(@Inject(DB) private readonly db: Database.Database, private readonly acl: AclService) {}

  // Omitted users are explicitly unrestricted internal system catalog operations.
  private notes(user?: AclUser) {
    const access = user ? this.acl.sql(user, 'c.path') : { sql: '1', params: [] };
    return { sql: `notes AS (SELECT path, title, tags_json FROM chunks c WHERE ordinal = 0 AND (${access.sql}))`, params: access.params };
  }

  private relations(user?: AclUser) {
    const scope = this.notes(user);
    const rows = this.db.prepare(`WITH ${scope.sql} SELECT * FROM notes ORDER BY path`).all(...scope.params) as CatalogNote[];
    const notes = new Map(rows.map((note) => [note.path, note]));
    let resolver: NoteTargetResolver | undefined;
    const indexed = this.db.prepare(`WITH ${scope.sql}
      SELECT links.source_path,links.target_name,links.target_text,links.target_path
      FROM links JOIN notes ON notes.path=links.source_path
      ORDER BY links.source_path,links.target_name`).all(...scope.params) as IndexedLink[];
    const edges: CatalogGraph['edges'] = [];
    const seen = new Set<string>();
    const unresolved = new Map<string, Set<string>>();
    for (const link of indexed) {
      // Never expose a globally resolved but unreadable destination as unresolved.
      if (user && link.target_path !== null && !this.acl.canRead(user, link.target_path)) continue;
      const text = link.target_text || link.target_name;
      const target = link.target_path ?? (resolver ??= new NoteTargetResolver([...notes.keys()])).resolve(text).path;
      if (target && notes.has(target)) {
        const key = `${link.source_path}\0${target}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ from: link.source_path, to: target });
        }
      } else {
        const names = unresolved.get(link.source_path) ?? new Set<string>();
        names.add(text);
        unresolved.set(link.source_path, names);
      }
    }
    edges.sort((left, right) => left.from < right.from ? -1 : left.from > right.from ? 1
      : left.to < right.to ? -1 : left.to > right.to ? 1 : 0);
    return { notes, edges, unresolved };
  }

  suggest(q: string, user?: AclUser): NoteSummary[] {
    const query = q.trim();
    if (!query) return [];
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const prefix = `${escaped}%`;
    const substring = `%${escaped}%`;
    const notes = this.notes(user);
    return this.db.prepare(`
      WITH ${notes.sql}
      SELECT path, title FROM notes
      WHERE title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0
        WHEN path LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, path
      LIMIT 20
    `).all(...notes.params, substring, substring, prefix, prefix) as NoteSummary[];
  }

  links(path: string, user?: AclUser): CatalogLinks {
    if (user) this.acl.assertRead(user, path);
    const { notes, edges, unresolved } = this.relations(user);
    const outgoing: NoteSummary[] = [];
    const backlinks: NoteSummary[] = [];
    for (const edge of edges) {
      if (edge.from === path) {
        const note = notes.get(edge.to)!;
        outgoing.push({ path: note.path, title: note.title });
      }
      if (edge.to === path) {
        const note = notes.get(edge.from)!;
        backlinks.push({ path: note.path, title: note.title });
      }
    }
    return { outgoing, backlinks, unresolved: [...(unresolved.get(path) ?? [])].sort() };
  }

  graph(path?: string, depth = 1, user?: AclUser): CatalogGraph {
    if (user && path !== undefined) this.acl.assertRead(user, path);
    const { notes, edges } = this.relations(user);
    const selected = new Set<string>(path === undefined ? notes.keys() : notes.has(path) ? [path] : []);
    if (path !== undefined) {
      // Traverse visible reader-resolved edges in both directions, retaining their orientation.
      const adjacency = new Map<string, string[]>();
      for (const edge of edges) {
        const from = adjacency.get(edge.from) ?? [];
        from.push(edge.to);
        adjacency.set(edge.from, from);
        const to = adjacency.get(edge.to) ?? [];
        to.push(edge.from);
        adjacency.set(edge.to, to);
      }
      let frontier = [...selected];
      for (let distance = 0; distance < depth && frontier.length; distance++) {
        const next: string[] = [];
        for (const current of frontier) for (const neighbor of adjacency.get(current) ?? []) {
          if (!selected.has(neighbor)) {
            selected.add(neighbor);
            next.push(neighbor);
          }
        }
        frontier = next;
      }
    }
    return {
      nodes: [...selected].sort().map((notePath) => {
        const note = notes.get(notePath)!;
        return { path: note.path, title: note.title, tags: JSON.parse(note.tags_json) as string[] };
      }),
      edges: edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
    };
  }

  tags(user?: AclUser): TagFacet[] {
    const notes = this.notes(user);
    return this.db.prepare(`
      WITH ${notes.sql}
      SELECT tag.value AS tag, COUNT(DISTINCT notes.path) AS count
      FROM notes, json_each(notes.tags_json) tag
      GROUP BY tag.value ORDER BY tag.value
    `).all(...notes.params) as TagFacet[];
  }

  tagNotes(tag: string, user?: AclUser): NoteSummary[] {
    const normalized = normalizeTag(tag);
    const notes = this.notes(user);
    return this.db.prepare(`
      WITH ${notes.sql}
      SELECT path, title FROM notes
      WHERE EXISTS (SELECT 1 FROM json_each(notes.tags_json) WHERE value = ?)
      ORDER BY path
    `).all(...notes.params, normalized) as NoteSummary[];
  }
}
