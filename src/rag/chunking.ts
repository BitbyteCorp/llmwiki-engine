import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import GithubSlugger from 'github-slugger';
import matter from 'gray-matter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { NOTE_TYPES, type NoteType } from '../knowledge/note-metadata.js';
import type { SearchHit } from './types.js';
import { normalizeLinkTarget } from './link-resolver.js';

export interface NoteChunk {
  title: string;
  heading: string;
  content: string;
  embeddingText: string;
  contentHash: string;
  kind: SearchHit['kind'];
  ordinal: number;
  tags: string[];
  type: NoteType | null;
  description: string | null;
  aliases: string[];
  anchor: string | null;
  sourceStart: number;
  sourceEnd: number;
}

interface Heading { level: number; text: string; anchor: string; start: number }
interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { id?: unknown };
  position?: { start: { offset?: number } };
  children?: MarkdownNode[];
}

const headingProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true }).freeze();

// Match the renderer's heading text and IDs, including entities, inline markup,
// setext headings, and all duplicate headings (even ones without indexed prose).
function headingsIn(body: string): Heading[] {
  const headings: Heading[] = [];
  const slugs = new GithubSlugger();
  const tree = headingProcessor.runSync(headingProcessor.parse(body));
  // The web's wikilink plugin displays aliases, not [[target|alias]] syntax.
  // Normalize only parsed heading text and leave inline code/ordinary links alone.
  const text = (node: MarkdownNode, literal = false): string => {
    if (node.type === 'text') {
      const value = node.value ?? '';
      return literal ? value : value.replace(/\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g,
        (raw: string, target: string, alias: string | undefined) => target.trim() ? alias?.trim() || target.trim() : raw);
    }
    const skipWiki = literal || node.tagName === 'code' || node.tagName === 'a';
    return (node.children ?? []).map((child) => text(child, skipWiki)).join('');
  };
  // rehype-slug and ReactMarkdown's postprocessing both use sibling indexOf
  // searches while walking the whole tree. Collect and slug headings in one
  // indexed traversal instead, without constructing discarded React elements.
  const visit = (node: MarkdownNode) => {
    if (node.tagName && /^h[1-6]$/.test(node.tagName)) {
      const value = text(node);
      const anchor = String(node.properties?.id || slugs.slug(value));
      if (node.position?.start.offset !== undefined) {
        headings.push({ level: Number(node.tagName[1]), text: value, anchor, start: node.position.start.offset });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return headings;
}

// Four ASCII characters or one non-ASCII code point per token. All positions
// are UTF-16 indices into the original markdown, never byte or code-point offsets.
const MAX_TOKEN_UNITS = 800 * 4;
const OVERLAP_TOKEN_UNITS = 80 * 4;

function boundedEnd(content: string, start: number, limit: number): number {
  let end = start;
  let units = 0;
  while (end < content.length) {
    const point = content.codePointAt(end)!;
    const cost = point <= 0x7f ? 1 : 4;
    if (units + cost > limit) break;
    units += cost;
    end += point > 0xffff ? 2 : 1;
  }
  return end;
}

function splitSection(content: string): Array<[number, number]> {
  const boundaries: Array<{ end: number; priority: number }> = [];
  for (const match of content.matchAll(/\n[ \t]*\r?\n|[.!?。！？](?:["'”’)]*)\s+|\n|[ \t]+/g)) {
    boundaries.push({ end: match.index + match[0].length,
      priority: /\n[ \t]*\r?\n/.test(match[0]) ? 3 : /^[.!?。！？]/.test(match[0]) ? 2 : 1 });
  }
  const parts: Array<[number, number]> = [];
  let start = 0;
  let boundaryStart = 0;
  while (start < content.length) {
    let end = boundedEnd(content, start, MAX_TOKEN_UNITS);
    if (end < content.length) {
      const maximum = end;
      const minimum = boundedEnd(content, start, MAX_TOKEN_UNITS / 2);
      let best = 0;
      while (boundaryStart < boundaries.length && boundaries[boundaryStart]!.end < minimum) boundaryStart++;
      for (let index = boundaryStart; index < boundaries.length; index++) {
        const boundary = boundaries[index]!;
        if (boundary.end > maximum) break;
        if (boundary.end >= minimum && boundary.priority >= best) {
          end = boundary.end;
          best = boundary.priority;
        }
      }
    }
    parts.push([start, end]);
    if (end === content.length) break;
    let overlap = end;
    let units = 0;
    while (overlap > start) {
      const last = content.charCodeAt(overlap - 1);
      const width = last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
      const point = content.codePointAt(overlap - width)!;
      const cost = point <= 0x7f ? 1 : 4;
      if (units + cost > OVERLAP_TOKEN_UNITS) break;
      units += cost;
      overlap -= width;
    }
    let semantic: { end: number; priority: number } | undefined;
    for (let index = boundaryStart; index < boundaries.length; index++) {
      const boundary = boundaries[index]!;
      if (boundary.end >= end) break;
      if (boundary.end >= overlap && boundary.priority >= 2 && (!semantic || boundary.priority > semantic.priority)) {
        semantic = boundary;
      }
    }
    start = semantic?.end ?? overlap;
  }
  return parts;
}

export function normalizeTag(value: string): string {
  return value.trim().normalize('NFKC').replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
}

function tagsFromFrontmatter(value: unknown): string[] {
  const values: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
  return [...new Set(values.filter((tag): tag is string => typeof tag === 'string').map(normalizeTag).filter(Boolean))];
}

export function aliasesFromFrontmatter(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return [];
  const aliases = new Map<string, string>();
  for (const item of value) {
    const alias = item.trim();
    const key = alias.toLowerCase();
    if (alias && !aliases.has(key)) aliases.set(key, alias);
  }
  return [...aliases.values()];
}

export function normalizedNoteHash(markdown: string): string {
  const normalized = markdown.normalize('NFKC').replace(/\r\n?/g, '\n')
    .split('\n').map((line) => line.trimEnd()).join('\n').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export function kindForPath(path: string): SearchHit['kind'] {
  if (path.startsWith('wiki/')) return 'wiki';
  if (path.startsWith('journal/')) return 'journal';
  if (path.startsWith('raw/')) return 'raw';
  return 'other';
}

export function chunkNote(path: string, markdown: string): NoteChunk[] {
  const { data, content: body } = matter(markdown);
  const bodyOffset = markdown.length - body.length;
  const headings = headingsIn(body);
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim()
    : headings.find((heading) => heading.level === 1 && heading.text)?.text || posix.basename(path).replace(/\.md$/i, '');
  const tags = tagsFromFrontmatter(data.tags);
  const type = (NOTE_TYPES as readonly unknown[]).includes(data.type) ? data.type as NoteType : null;
  const description = typeof data.description === 'string' && data.description.trim() ? data.description.trim() : null;
  const aliases = aliasesFromFrontmatter(data.aliases);
  const sections: Array<{ start: number; end: number; heading: string; anchor: string | null }> = [];
  const context: string[] = [];
  let start = 0;
  let anchor: string | null = null;
  let heading = '';
  for (const current of headings) {
    if (current.level === 1 && anchor === null && sections.length === 0) {
      anchor = current.anchor;
      continue;
    }
    if (current.start > start) sections.push({ start, end: current.start, heading, anchor });
    if (current.level === 1) {
      context.length = 0;
      heading = '';
    } else {
      context.length = current.level - 2;
      context[current.level - 2] = current.text;
      heading = context.filter(Boolean).join(' > ');
    }
    anchor = current.anchor;
    start = current.start;
  }
  sections.push({ start, end: body.length, heading, anchor });
  const kind = kindForPath(path);
  const chunks: NoteChunk[] = [];
  for (const section of sections) {
    const content = body.slice(section.start, section.end);
    if (!content.trim()) continue;
    const header = [title, section.heading].filter(Boolean).join(' > ')
      + (tags.length ? `\n태그: ${tags.join(', ')}` : '')
      + (description ? `\n설명: ${description}` : '')
      + (aliases.length ? `\n별칭: ${aliases.join(', ')}` : '');
    for (const [start, end] of splitSection(content)) {
      const raw = content.slice(start, end);
      const embeddingText = `${header}\n\n${raw}`;
      chunks.push({ title, heading: section.heading, content: raw, embeddingText,
        contentHash: createHash('sha256').update(embeddingText).digest('hex'), kind, ordinal: chunks.length,
        tags, type, description, aliases, anchor: section.anchor, sourceStart: bodyOffset + section.start + start,
        sourceEnd: bodyOffset + section.start + end });
    }
  }
  return chunks;
}

export function wikilinkTargets(markdown: string): Array<{ name: string; text: string }> {
  const targets = new Map<string, string>();
  for (const match of markdown.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) {
    const text = match[1]!.split(/[|#]/, 1)[0]!.trim();
    const name = normalizeLinkTarget(text);
    if (name && !targets.has(name)) targets.set(name, text);
  }
  return [...targets].map(([name, text]) => ({ name, text }));
}
