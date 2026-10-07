export interface SearchHit {
  path: string;
  title: string;
  heading: string;
  snippet: string;
  score: number;
  kind: 'wiki' | 'journal' | 'raw' | 'other';
  related: string[];
  anchor: string | null;
  excerpt: string;
  highlights: Array<[number, number]>;
  tags: string[];
  updatedAt: string | null;
}

export interface SearchFilters {
  kinds?: SearchHit['kind'][];
  folder?: string;
  tags?: string[];
  from?: string;
  to?: string;
  author?: string;
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  cursor?: string;
}

export type DegradedReason = 'no_api_key' | 'embedding_error' | 'vector_mismatch' | 'index_stale';

export interface SearchResult {
  mode: 'hybrid' | 'keyword';
  degraded: { reason: DegradedReason } | null;
  hits: SearchHit[];
  nextCursor: string | null;
}
