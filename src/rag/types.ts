export interface SearchHit {
  path: string;
  title: string;
  heading: string;
  snippet: string;
  score: number;
  kind: 'wiki' | 'journal' | 'raw' | 'other';
  related: string[];
}
