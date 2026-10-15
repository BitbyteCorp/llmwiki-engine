import type { User } from '../auth/users.types.js';
import type { NoteType } from '../knowledge/note-metadata.js';

export interface SearchVia {
  path: string;
  heading: string;
  anchor: string | null;
  excerpt: string;
  highlights: Array<[number, number]>;
}

export interface SearchHit {
  path: string;
  title: string;
  heading: string;
  snippet: string;
  score: number;
  kind: 'wiki' | 'journal' | 'raw' | 'other';
  type: NoteType | null;
  description: string | null;
  related: string[];
  anchor: string | null;
  excerpt: string;
  highlights: Array<[number, number]>;
  tags: string[];
  updatedAt: string | null;
  via: SearchVia | null;
}

export interface SearchFilters {
  kinds?: SearchHit['kind'][];
  type?: NoteType;
  folder?: string;
  tags?: string[];
  from?: string;
  to?: string;
  author?: string;
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  cursor?: string;
  /** Omit only for explicitly unrestricted internal system retrieval. */
  user?: Pick<User, 'id' | 'role'>;
}

export type DegradedReason = 'no_api_key' | 'embedding_error' | 'vector_mismatch' | 'index_stale';

export interface SearchResult {
  mode: 'hybrid' | 'keyword';
  degraded: { reason: DegradedReason } | null;
  hits: SearchHit[];
  nextCursor: string | null;
}
