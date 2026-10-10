import { posix } from 'node:path';
import { createRequire } from 'node:module';
import matter from 'gray-matter';
import { domainHubPath, domainOf } from './domains.js';

/** Controlled `type` vocabulary for wiki notes. */
export const NOTE_TYPES = ['hub', 'concept', 'entity', 'guide', 'decision', 'reference', 'project', 'note'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** Allowed values for `confidence` (evidence strength) and `importance` (operational weight). */
export const METADATA_LEVELS = ['high', 'medium', 'low'] as const;

/** Fields every wiki note carries, in canonical order (shared by both reference systems). */
export const REQUIRED_FIELDS = ['type', 'aliases', 'description', 'author', 'date created', 'date modified', 'tags'] as const;

/** Fields the engine fills deterministically on write; the agent never has to compute them. */
export const ENGINE_FIELDS = ['author', 'date created', 'date modified'] as const;

/** Classification the folder already expresses, or replaced fields (`updated` → `date modified`). */
export const FORBIDDEN_FIELDS = ['domain', 'category', 'status', 'updated'] as const;

export const DESCRIPTION_MAX_CHARS = 300;

export interface MetadataIssue {
  field: string;
  message: string;
}

const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WIKILINK_PATTERN = /^\[\[[^\][]+\]\]$/;
const URL_PATTERN = /^https?:\/\/\S+$/;

/** Wiki notes that must follow the metadata standard: `wiki/**\/*.md` except domain schema files. */
export function isMetadataTarget(path: string): boolean {
  return path.startsWith('wiki/') && /\.md$/i.test(path) && posix.basename(path) !== 'AGENTS.md';
}

/** `type` implied by placement, or null when any note type is allowed there. */
export function expectedNoteType(path: string): NoteType | null {
  if (path.startsWith('wiki/concepts/')) return 'concept';
  if (path.startsWith('wiki/entities/')) return 'entity';
  const domain = domainOf(path);
  return domain && path === domainHubPath(domain) ? 'hub' : null;
}

/** Normalizes YAML dates (js-yaml parses bare dates as Date) to `YYYY-MM-DD`, or null when invalid. */
export function metadataDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return typeof value === 'string' && DATE_PATTERN.test(value) ? value : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

/** Validates one note's frontmatter against the metadata standard. Callers filter with `isMetadataTarget`. */
export function validateNoteMetadata(path: string, content: string): MetadataIssue[] {
  let data: Record<string, unknown>;
  try {
    data = matter(content).data;
  } catch {
    return [{ field: 'frontmatter', message: 'frontmatter YAML를 해석할 수 없다' }];
  }
  const issues: MetadataIssue[] = [];
  const issue = (field: string, message: string) => issues.push({ field, message });

  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === null) issue(field, '필수 속성이 없다');
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (data[field] !== undefined) issue(field, '사용하지 않는 속성이다');
  }

  if (data.type !== undefined) {
    if (!(NOTE_TYPES as readonly unknown[]).includes(data.type)) {
      issue('type', `허용 값은 ${NOTE_TYPES.join(', ')}이다`);
    } else {
      const expected = expectedNoteType(path);
      if (expected && data.type !== expected) issue('type', `이 위치의 노트는 ${expected}여야 한다`);
    }
  }
  if (data.aliases !== undefined && !stringList(data.aliases)) issue('aliases', '문자열 목록이어야 한다');
  if (data.description !== undefined) {
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    if (!description) issue('description', '비어 있지 않은 문자열이어야 한다');
    else if (description.length > DESCRIPTION_MAX_CHARS) issue('description', `${DESCRIPTION_MAX_CHARS}자 이하여야 한다`);
  }
  if (data.author !== undefined) {
    const authors = stringList(data.author);
    if (!authors || authors.length === 0) issue('author', '비어 있지 않은 문자열 목록이어야 한다');
  }
  if (data.tags !== undefined) {
    const tags = stringList(data.tags);
    if (!tags || tags.length === 0) issue('tags', '비어 있지 않은 문자열 목록이어야 한다');
    else {
      const invalid = tags.filter((tag) => !TAG_PATTERN.test(tag));
      if (invalid.length) issue('tags', `영어 소문자 kebab-case가 아니다: ${invalid.join(', ')}`);
    }
  }

  const created = data['date created'] === undefined ? undefined : metadataDate(data['date created']);
  const modified = data['date modified'] === undefined ? undefined : metadataDate(data['date modified']);
  if (created === null) issue('date created', 'YYYY-MM-DD 형식이어야 한다');
  if (modified === null) issue('date modified', 'YYYY-MM-DD 형식이어야 한다');
  if (created && modified && created > modified) issue('date modified', 'date created보다 이를 수 없다');

  if (data.related !== undefined) {
    const related = stringList(data.related);
    if (!related || !related.every((item) => WIKILINK_PATTERN.test(item))) {
      issue('related', '"[[노트]]" 위키링크 목록이어야 한다');
    }
  }
  if (data.source !== undefined) {
    const source = stringList(data.source);
    if (!source || !source.every((item) => WIKILINK_PATTERN.test(item) || URL_PATTERN.test(item))) {
      issue('source', '"[[원문]]" 위키링크 또는 http(s) URL 목록이어야 한다');
    }
  }
  for (const field of ['confidence', 'importance'] as const) {
    if (data[field] !== undefined && !(METADATA_LEVELS as readonly unknown[]).includes(data[field])) {
      issue(field, `허용 값은 ${METADATA_LEVELS.join(', ')}이다`);
    }
  }
  return issues;
}

/** The journal calendar is Korea time, independently of the dreaming scheduler's timezone. */
export function noteMetadataDate(now = new Date(), timeZone = 'Asia/Seoul'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export interface NoteMetadataStamp {
  date: string;
  /** Omit for dreaming/system writes: the bot is credited only when the author list is empty. */
  requesterName?: string;
  botName: string;
}

interface YamlNode {
  start: number;
  end: number;
  kind: string | null;
  value: unknown;
  children: YamlNode[];
}
interface YamlState { position: number; kind: string | null; result: unknown }
interface ParsedYamlRanges { data: Record<string, unknown>; root: YamlNode }
// Reuse gray-matter's installed YAML parser, rather than introduce a second YAML dependency.
// Its listener exposes source offsets, including quoted keys and nested/flow collections.
const yaml: {
  safeLoad(input: string, options: { listener: (event: 'open' | 'close', state: YamlState) => void }): unknown;
} = createRequire(createRequire(import.meta.url).resolve('gray-matter'))('js-yaml');

function parseYamlRanges(input: string): ParsedYamlRanges | null {
  const stack: YamlNode[] = [];
  let root: YamlNode | undefined;
  const data = yaml.safeLoad(input, {
    listener(event, state) {
      if (event === 'open') {
        const node: YamlNode = { start: state.position, end: state.position, kind: null, value: null, children: [] };
        stack.at(-1)?.children.push(node);
        root ??= node;
        stack.push(node);
      } else {
        const node = stack.pop()!;
        node.end = Math.min(state.position, input.length);
        node.kind = state.kind;
        node.value = state.result;
      }
    },
  });
  if (!root) {
    if (data !== undefined) return null;
    const empty: Record<string, unknown> = {};
    return { data: empty, root: { start: 0, end: input.length, kind: 'mapping', value: empty, children: [] } };
  }
  // js-yaml tries a block mapping by composing its first key. For a top-level flow
  // mapping it returns that composed mapping as the document, leaving a wrapper
  // listener node whose only child owns the actual key/value ranges.
  let mapping: YamlNode = root;
  while (mapping.children.length === 1) {
    const child: YamlNode = mapping.children[0]!;
    if (child.kind !== mapping.kind || child.value !== mapping.value) break;
    mapping = child;
  }
  if (data === undefined || data === null) return mapping.kind === null ? { data: {}, root: mapping } : null;
  if (typeof data !== 'object' || Array.isArray(data) || mapping.kind !== 'mapping') return null;
  return { data: data as Record<string, unknown>, root: mapping };
}

/** Fill only engine-owned fields. All other YAML and the complete body remain byte-for-byte.
 * Parser offsets avoid reserializing frontmatter (which drops comments/styles/custom metadata).
 * Invalid or unterminated YAML is left intact: stamping must never discard data or abort a merge;
 * the metadata validator remains responsible for reporting/repairing those documents.
 */
export function stampNoteMetadata(content: string, stamp: NoteMetadataStamp): string {
  const opening = /^(?:\uFEFF)?---[ \t]*(\r?\n)/.exec(content);
  const eol = opening?.[1] ?? (content.includes('\r\n') ? '\r\n' : '\n');
  const newFields = `author: ${JSON.stringify([stamp.requesterName ?? stamp.botName])}${eol}date created: ${stamp.date}${eol}date modified: ${stamp.date}${eol}`;
  const name = stamp.requesterName ?? stamp.botName;
  if (!opening) return `---${eol}${newFields}---${eol}${content}`;
  const offset = opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = offset;
  const end = closing.exec(content);
  if (!end) return content;
  const source = content.slice(offset, end.index);
  let parsed: ParsedYamlRanges | null;
  try { parsed = parseYamlRanges(source); } catch { return content; }
  if (!parsed) return content;
  const { data, root } = parsed;
  const fields = new Map<string, YamlNode>();
  for (let i = 0; i + 1 < root.children.length; i += 2) {
    const key = root.children[i]!;
    if (typeof key.value === 'string') fields.set(key.value, root.children[i + 1]!);
  }
  const edits: { start: number; end: number; text: string }[] = [];
  const missing: string[] = [];
  const skipSeparation = (start: number, limit: number): number => {
    while (start < limit) {
      if (/\s/.test(source[start]!)) { start++; continue; }
      if (source[start] === '#') {
        const newline = source.indexOf('\n', start);
        start = newline < 0 ? limit : newline + 1;
        continue;
      }
      // Keep YAML tags/anchors outside the edited value range so unrelated aliases survive.
      if (source[start] === '&' || source[start] === '!') {
        while (start < limit && !/\s/.test(source[start]!)) start++;
        continue;
      }
      break;
    }
    return start;
  };
  const replace = (field: string, text: string) => {
    const node = fields.get(field);
    if (!node) { missing.push(`${field}: ${text}`); return; }
    const start = skipSeparation(node.start, node.end);
    let finish = node.end;
    while (finish > start && /\s/.test(source[finish - 1]!)) finish--;
    // A null value has no token: insert immediately after its key's colon, before comments.
    edits.push(start === finish
      ? { start: node.start, end: node.start, text: ` ${text}` }
      : { start, end: finish, text });
  };
  if (data['date created'] === undefined || data['date created'] === null) replace('date created', stamp.date);
  if (metadataDate(data['date modified']) !== stamp.date) replace('date modified', stamp.date);
  const authors = stringList(data.author);
  if (!authors) {
    const legacy = typeof data.author === 'string' && data.author.trim() ? [data.author] : [];
    if (!legacy.length || (stamp.requesterName !== undefined && !legacy.includes(name))) legacy.push(name);
    replace('author', JSON.stringify(legacy));
  } else if (authors.length === 0) {
    replace('author', JSON.stringify([name]));
  } else if (stamp.requesterName !== undefined && !authors.includes(name)) {
    const node = fields.get('author');
    const last = node?.children.at(-1);
    if (!node || !last) replace('author', JSON.stringify([...authors, name]));
    else if (source[skipSeparation(node.start, node.end)] === '[') {
      // Append after the last item, before an optional trailing comma/comment.
      edits.push({ start: last.end, end: last.end, text: `, ${JSON.stringify(name)}` });
    } else {
      const first = node.children[0]!;
      const lineStart = source.lastIndexOf('\n', first.start) + 1;
      const indent = /^([ \t]*)-/.exec(source.slice(lineStart, first.start))?.[1] ?? '';
      const newline = source.indexOf('\n', Math.max(last.start, last.end - 1));
      const at = newline < 0 ? source.length : (source[newline - 1] === '\r' ? newline - 1 : newline);
      edits.push({ start: at, end: at, text: `${eol}${indent}- ${JSON.stringify(name)}` });
    }
  }
  if (missing.length) {
    const start = skipSeparation(root.start, root.end);
    if (source[start] === '{') {
      const last = root.children.at(-1);
      const at = last?.end ?? start + 1;
      edits.push({ start: at, end: at, text: `${last ? ', ' : ''}${missing.join(', ')}` });
    } else {
      edits.push({ start: source.length, end: source.length, text: `${source && !source.endsWith('\n') ? eol : ''}${missing.join(eol)}${eol}` });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return content.slice(0, offset) + result + content.slice(end.index);
}
