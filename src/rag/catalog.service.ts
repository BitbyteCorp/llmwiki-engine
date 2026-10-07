import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { DB } from '../common/tokens.js';
import { AclService, type AclUser } from '../acl/acl.service.js';
import { normalizeTag } from './chunking.js';

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

const resolvedEdges = `edges AS (
  SELECT DISTINCT source_path AS "from", target_path AS "to"
  FROM links JOIN notes source ON source.path = source_path
    JOIN notes target ON target.path = target_path
)`;

@Injectable()
export class CatalogService {
  constructor(@Inject(DB) private readonly db: Database.Database, private readonly acl: AclService) {}

  // Omitted users are explicitly unrestricted internal system catalog operations.
  private notes(user?: AclUser) {
    const access = user ? this.acl.sql(user, 'c.path') : { sql: '1', params: [] };
    return { sql: `notes AS (SELECT path, title, tags_json FROM chunks c WHERE ordinal = 0 AND (${access.sql}))`, params: access.params };
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
    const notes = this.notes(user);
    const outgoing = this.db.prepare(`
      WITH ${notes.sql}
      SELECT DISTINCT notes.path, notes.title FROM links
      JOIN notes ON notes.path = links.target_path
      WHERE links.source_path = ? ORDER BY notes.path
    `).all(...notes.params, path) as NoteSummary[];
    const backlinks = this.db.prepare(`
      WITH ${notes.sql}
      SELECT DISTINCT notes.path, notes.title FROM links
      JOIN notes ON notes.path = links.source_path
      WHERE links.target_path = ? ORDER BY notes.path
    `).all(...notes.params, path) as NoteSummary[];
    const target = user ? this.acl.sql(user, 'links.target_path') : { sql: '1', params: [] };
    const unresolved = this.db.prepare(`
      SELECT DISTINCT target_name FROM links
      WHERE source_path = ? AND (target_path IS NULL
        OR ((${target.sql}) AND NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.path = links.target_path)))
      ORDER BY target_name
    `).all(path, ...target.params) as Array<{ target_name: string }>;
    return { outgoing, backlinks, unresolved: unresolved.map((link) => link.target_name) };
  }

  graph(path?: string, depth = 1, user?: AclUser): CatalogGraph {
    if (user && path !== undefined) this.acl.assertRead(user, path);
    const notes = this.notes(user);
    // A neighborhood follows both outgoing links and backlinks; returned edges keep direction.
    const scope = path === undefined ? `WITH ${notes.sql}, ${resolvedEdges}, selected AS (SELECT path FROM notes)` : `
      WITH RECURSIVE ${notes.sql}, ${resolvedEdges},
      adjacency AS (
        SELECT "from", "to" FROM edges UNION SELECT "to", "from" FROM edges
      ), neighborhood(path, distance) AS (
        SELECT path, 0 FROM notes WHERE path = ?
        UNION
        SELECT adjacency."to", neighborhood.distance + 1
        FROM neighborhood JOIN adjacency ON adjacency."from" = neighborhood.path
        WHERE neighborhood.distance < ?
      ), selected AS (SELECT DISTINCT path FROM neighborhood)
    `;
    const params = [...notes.params, ...(path === undefined ? [] : [path, depth])];
    const rows = this.db.prepare(`
      ${scope}
      SELECT notes.path, title, tags_json FROM notes JOIN selected USING (path) ORDER BY notes.path
    `).all(...params) as Array<NoteSummary & { tags_json: string }>;
    const edges = this.db.prepare(`
      ${scope}
      SELECT "from", "to" FROM edges
      WHERE "from" IN (SELECT path FROM selected) AND "to" IN (SELECT path FROM selected)
      ORDER BY "from", "to"
    `).all(...params) as CatalogGraph['edges'];
    return {
      nodes: rows.map(({ path: notePath, title, tags_json }) => ({
        path: notePath, title, tags: JSON.parse(tags_json) as string[],
      })),
      edges,
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
