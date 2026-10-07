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
interface DerivedLink {
  source: string;
  target: string | null;
  text: string;
  candidates: readonly string[];
}
interface CatalogSnapshot {
  sha: string | null;
  generation: string;
  notes: Map<string, CatalogNote>;
  outgoing: Map<string, DerivedLink[]>;
  incoming: Map<string, DerivedLink[]>;
  tags: Map<string, string[]>;
}

@Injectable()
export class CatalogService {
  // Keep only the current pre-ACL index, never user projections or historical SHAs.
  private snapshot: CatalogSnapshot | undefined;
  private readonly readVersion;

  constructor(@Inject(DB) private readonly db: Database.Database, private readonly acl: AclService) {
    this.readVersion = db.prepare(`SELECT
      (SELECT value FROM index_meta WHERE key = 'indexed_sha') AS sha,
      COALESCE((SELECT value FROM index_meta WHERE key = 'catalog_revision'),
        CAST(total_changes() AS TEXT)) AS generation`);
  }

  // Omitted users are explicitly unrestricted internal system catalog operations.
  private notes(user?: AclUser) {
    const access = user ? this.acl.sql(user, 'c.path') : { sql: '1', params: [] };
    return { sql: `notes AS (SELECT path, title, tags_json FROM chunks c WHERE ordinal = 0 AND (${access.sql}))`, params: access.params };
  }

  private indexSnapshot(): CatalogSnapshot {
    const version = this.readVersion.get() as { sha: string | null; generation: string };
    // The indexer's transactional generation changes even for same-SHA rebuilds.
    // Before the first sync, total_changes also keeps direct DB fixtures fresh.
    if (this.snapshot?.sha === version.sha && this.snapshot.generation === version.generation) return this.snapshot;

    const rows = this.db.prepare('SELECT path,title,tags_json FROM chunks WHERE ordinal = 0 ORDER BY path').all() as CatalogNote[];
    const notes = new Map(rows.map((note) => [note.path, note]));
    const resolver = new NoteTargetResolver([...notes.keys()]);
    const outgoing = new Map<string, DerivedLink[]>();
    const incoming = new Map<string, DerivedLink[]>();
    const append = (map: Map<string, DerivedLink[]>, path: string, link: DerivedLink) => {
      const links = map.get(path);
      if (links) links.push(link);
      else map.set(path, [link]);
    };
    const indexed = this.db.prepare(`SELECT source_path,target_name,target_text,target_path
      FROM links ORDER BY source_path,target_name`).all() as IndexedLink[];
    for (const row of indexed) {
      if (!notes.has(row.source_path)) continue;
      const text = row.target_text || row.target_name;
      const candidates = row.target_path === null ? resolver.resolve(text).candidates : [row.target_path];
      const link: DerivedLink = { source: row.source_path, target: row.target_path, text, candidates };
      append(outgoing, link.source, link);
      for (const candidate of candidates) if (notes.has(candidate)) append(incoming, candidate, link);
    }
    this.snapshot = { ...version, notes, outgoing, incoming, tags: new Map() };
    return this.snapshot;
  }

  private reader(snapshot: CatalogSnapshot, user?: AclUser) {
    const predicate = user ? this.acl.readPredicate(user) : () => true;
    const visibility = new Map<string, boolean>();
    const readable = (path: string) => {
      let allowed = visibility.get(path);
      if (allowed === undefined) {
        allowed = predicate(path);
        visibility.set(path, allowed);
      }
      return allowed;
    };
    const targets = new Map<DerivedLink, string | null | undefined>();
    const target = (link: DerivedLink): string | null | undefined => {
      if (targets.has(link)) return targets.get(link);
      let resolved: string | null | undefined;
      if (!readable(link.source)) resolved = undefined;
      else if (link.target !== null) {
        // A hidden resolved destination must not leak through unresolved spelling.
        resolved = !readable(link.target) ? undefined : snapshot.notes.has(link.target) ? link.target : null;
      } else {
        resolved = null;
        for (const candidate of link.candidates) {
          if (!readable(candidate)) continue;
          if (resolved !== null) {
            resolved = null;
            break;
          }
          resolved = candidate;
        }
      }
      targets.set(link, resolved);
      return resolved;
    };
    return { readable, target };
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
    const snapshot = this.indexSnapshot();
    const { target } = this.reader(snapshot, user);
    const outgoing = new Set<string>();
    const backlinks = new Set<string>();
    const unresolved = new Set<string>();
    for (const link of snapshot.outgoing.get(path) ?? []) {
      const destination = target(link);
      if (destination === null) unresolved.add(link.text);
      else if (destination !== undefined) outgoing.add(destination);
    }
    for (const link of snapshot.incoming.get(path) ?? []) {
      if (target(link) === path) backlinks.add(link.source);
    }
    const summaries = (paths: Set<string>): NoteSummary[] => [...paths].sort().map((notePath) => {
      const note = snapshot.notes.get(notePath)!;
      return { path: note.path, title: note.title };
    });
    return { outgoing: summaries(outgoing), backlinks: summaries(backlinks), unresolved: [...unresolved].sort() };
  }

  graph(path?: string, depth = 1, user?: AclUser): CatalogGraph {
    if (user && path !== undefined) this.acl.assertRead(user, path);
    const snapshot = this.indexSnapshot();
    const { readable, target } = this.reader(snapshot, user);
    const selected = new Set<string>(path === undefined
      ? [...snapshot.notes.keys()].filter(readable)
      : snapshot.notes.has(path) && readable(path) ? [path] : []);
    if (path !== undefined) {
      // Traverse only incident reader-resolved links, preserving their orientation.
      let frontier = [...selected];
      for (let distance = 0; distance < depth && frontier.length; distance++) {
        const next: string[] = [];
        const visit = (neighbor: string) => {
          if (!selected.has(neighbor)) {
            selected.add(neighbor);
            next.push(neighbor);
          }
        };
        for (const current of frontier) {
          for (const link of snapshot.outgoing.get(current) ?? []) {
            const destination = target(link);
            if (destination !== null && destination !== undefined) visit(destination);
          }
          for (const link of snapshot.incoming.get(current) ?? []) {
            if (target(link) === current) visit(link.source);
          }
        }
        frontier = next;
      }
    }
    const edges: CatalogGraph['edges'] = [];
    const nodes = [...selected].sort().map((notePath) => {
      const note = snapshot.notes.get(notePath)!;
      let tags = snapshot.tags.get(notePath);
      if (!tags) {
        tags = JSON.parse(note.tags_json) as string[];
        snapshot.tags.set(notePath, tags);
      }
      const destinations = new Set<string>();
      for (const link of snapshot.outgoing.get(notePath) ?? []) {
        const destination = target(link);
        if (destination !== null && destination !== undefined && selected.has(destination)) destinations.add(destination);
      }
      for (const destination of [...destinations].sort()) edges.push({ from: notePath, to: destination });
      return { path: note.path, title: note.title, tags: [...tags] };
    });
    return { nodes, edges };
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
