import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import matter from 'gray-matter';
import type { SearchHit } from './types.js';

export interface NoteChunk {
  title: string;
  heading: string;
  content: string;
  embeddingText: string;
  contentHash: string;
  kind: SearchHit['kind'];
  ordinal: number;
}

interface Section {
  heading: string;
  content: string;
}

// Conservative multilingual approximation: four ASCII characters or one
// non-ASCII code point per token. Quarter-token units avoid rounding drift.
const MAX_TOKEN_UNITS = 800 * 4;

function splitSection(content: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = start;
    let units = 0;
    let lineBreak = 0;
    let wordBreak = 0;
    while (end < content.length) {
      const codePoint = content.codePointAt(end)!;
      const width = codePoint > 0xffff ? 2 : 1;
      const cost = codePoint <= 0x7f ? 1 : 4;
      if (units + cost > MAX_TOKEN_UNITS) break;
      units += cost;
      end += width;
      if (units >= MAX_TOKEN_UNITS / 2) {
        if (codePoint === 10) lineBreak = end;
        if (codePoint === 32 || codePoint === 9 || codePoint === 10) wordBreak = end;
      }
    }
    if (end < content.length) end = lineBreak || wordBreak || end;
    parts.push(content.slice(start, end));
    start = end;
  }
  return parts;
}

function tagsFromFrontmatter(value: unknown): string[] {
  const values: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/[,\s]+/) : [];
  return [...new Set(values.filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim()).filter(Boolean))];
}

export function kindForPath(path: string): SearchHit['kind'] {
  if (path.startsWith('wiki/')) return 'wiki';
  if (path.startsWith('journal/')) return 'journal';
  if (path.startsWith('raw/')) return 'raw';
  return 'other';
}

export function chunkNote(path: string, markdown: string): NoteChunk[] {
  const { data, content: body } = matter(markdown);
  const sections: Section[] = [];
  let lines: string[] = [];
  let firstH1 = '';
  let h2 = '';
  let h3 = '';
  let fence: { marker: string; length: number } | null = null;

  const flush = () => {
    const content = lines.join('');
    if (content.trim()) sections.push({ heading: [h2, h3].filter(Boolean).join(' > '), content });
    lines = [];
  };

  for (const match of body.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0];
    if (!line) continue;
    const text = line.replace(/\r?\n$/, '');
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence.marker
        && fenceMatch[1]!.length >= fence.length && !fenceMatch[2]!.trim()) {
        fence = null;
      }
      lines.push(line);
      continue;
    }
    if (fenceMatch && (fenceMatch[1]![0] !== '`' || !fenceMatch[2]!.includes('`'))) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      lines.push(line);
      continue;
    }
    const headingMatch = /^ {0,3}(#{1,3})(?:[ \t]+(.*)|[ \t]*)$/.exec(text);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const heading = (headingMatch[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      if (level === 1 && !firstH1 && heading) firstH1 = heading;
      if (level === 2 || level === 3) {
        flush();
        if (level === 2) {
          h2 = heading;
          h3 = '';
        } else {
          h3 = heading;
        }
      }
    }
    lines.push(line);
  }
  flush();

  const title = typeof data.title === 'string' && data.title.trim()
    ? data.title.trim() : firstH1 || posix.basename(path).replace(/\.md$/i, '');
  const tags = tagsFromFrontmatter(data.tags);
  const kind = kindForPath(path);
  const chunks: NoteChunk[] = [];
  for (const section of sections) {
    const header = [title, section.heading].filter(Boolean).join(' > ')
      + (tags.length ? `\n태그: ${tags.join(', ')}` : '');
    for (const content of splitSection(section.content)) {
      const embeddingText = `${header}\n\n${content}`;
      chunks.push({
        title, heading: section.heading, content, embeddingText,
        contentHash: createHash('sha256').update(embeddingText).digest('hex'),
        kind, ordinal: chunks.length,
      });
    }
  }
  return chunks;
}

export function wikilinkTargets(markdown: string): string[] {
  const targets = new Set<string>();
  for (const match of markdown.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) {
    const target = match[1]!.split(/[|#]/, 1)[0]!.trim();
    const name = posix.basename(target).replace(/\.md$/i, '').trim().toLowerCase();
    if (name) targets.add(name);
  }
  return [...targets];
}
