import { posix, win32 } from 'node:path';
import { Readability } from '@mozilla/readability';
import { Unzip, UnzipInflate } from 'fflate';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { extractText, getDocumentProxy } from 'unpdf';
import type { PDFDocumentProxy } from 'unpdf/pdfjs';
import { ApiError } from '../api/api-error.js';
import { SOURCE_BYTES } from './safe-fetch.js';

export const VAULT_BYTES = 100 * 1024 * 1024;
export const VAULT_FILES = 1000;
function fail(message: string): never { throw new ApiError(400, 'invalid_source', message); }
export interface ExtractedFile { path: string; buffer: Buffer; markdown: boolean }
export interface Extraction { title: string; markdown: string; files: ExtractedFile[] }

export function safeFilename(input: string): string {
  return (input.normalize('NFC').replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '').slice(0, 160) || 'source');
}
export function markdownHref(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment).replace(/[()]/g, (char) => char === '(' ? '%28' : '%29')).join('/');
}
export function decodeText(buffer: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return fail('Source is not valid UTF-8 text'); }
}

export async function extractDocument(buffer: Buffer, mediaType: string, name: string, url?: string): Promise<Extraction> {
  if (buffer.length > SOURCE_BYTES) throw new ApiError(413, 'source_too_large', 'Document exceeds 20 MiB');
  if (mediaType === 'application/pdf' || buffer.subarray(0, 5).toString() === '%PDF-') {
    let pdf: PDFDocumentProxy | undefined;
    try {
      // PDF.js may transfer/detach its input; retain the original immutable bytes.
      pdf = await getDocumentProxy(new Uint8Array(buffer));
      if (pdf.numPages > 500) fail('PDF exceeds 500 pages');
      const { text } = await extractText(pdf, { mergePages: true });
      if (!text.trim()) fail('PDF contains no extractable text (OCR is not performed)');
      if (Buffer.byteLength(text) > SOURCE_BYTES) fail('Extracted PDF text exceeds the byte limit');
      return { title: name, markdown: text, files: [] };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return fail('PDF could not be parsed or requires a password');
    } finally { await pdf?.loadingTask.destroy(); }
  }
  const text = decodeText(buffer);
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    const { document } = parseHTML(text);
    if (url) {
      // Resolve relative links without ever fetching images or embedded resources.
      for (const element of document.querySelectorAll('[href], [src]')) {
        for (const attr of ['href', 'src']) {
          const value = element.getAttribute(attr);
          if (!value) continue;
          try {
            const resolved = new URL(value, url);
            if (['http:', 'https:'].includes(resolved.protocol)) element.setAttribute(attr, resolved.href);
            else if (!value.startsWith('#')) element.removeAttribute(attr);
          } catch { element.removeAttribute(attr); }
        }
      }
    }
    for (const element of document.querySelectorAll('script,style,iframe,form')) element.remove();
    const article = new Readability(document as unknown as Document).parse();
    if (!article?.content) fail('HTML contains no readable article');
    const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(article.content!);
    if (!markdown.trim()) fail('HTML contains no readable text');
    return { title: article.title || name, markdown, files: [] };
  }
  if (!['text/plain', 'text/markdown'].includes(mediaType)) fail('Unsupported document content type');
  if (!text.trim()) fail('Source text is empty');
  return { title: name, markdown: text, files: [] };
}

function safeArchivePath(path: string): string {
  if (path.startsWith('/') || win32.isAbsolute(path) || /[\\\x00-\x1f\x7f]/.test(path) ||
    path.split('/').some((part) => part === '..' || part === '.' || part.toLowerCase() === '.git') ||
    path.replace(/\/$/, '').split('/').some((part) => !part) || path.length > 1024) fail('Unsafe ZIP entry path');
  return path.normalize('NFC');
}

const NOTION_ID = /(?: |%20|[-_])(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?=\.[^.]+$|$)/gi;

/** Strip export page IDs from every path segment, not from prose. */
export function notionPath(path: string): string {
  return path.split('/').map((part) => part.replace(NOTION_ID, '')).join('/');
}

/**
 * Map archive paths to ID-free paths. Notion allows same-title siblings, so names whose stripped
 * form is shared by distinct page IDs (or by an ID-less file) keep their export ID. A page file and
 * its child folder share one ID; ID-less child folders (newer exports) add no identity of their own.
 */
function notionPaths(originals: Iterable<string>): Map<string, string> {
  const segments = (path: string) => {
    const parts = path.replace(/\/$/, '').split('/');
    return parts.map((part, index) => {
      const file = index === parts.length - 1 && !path.endsWith('/');
      const page = file ? part.replace(/\.[^.]+$/, '') : part;
      return { part, id: page.match(NOTION_ID)?.[0] ?? (file ? '' : undefined), group: `${parts.slice(0, index).join('/')}\0${page.replace(NOTION_ID, '')}` };
    });
  };
  const ids = new Map<string, Set<string>>();
  const paths = [...originals];
  for (const path of paths) for (const { id, group } of segments(path)) {
    const known = ids.get(group) ?? ids.set(group, new Set()).get(group)!;
    if (id !== undefined) known.add(id);
  }
  return new Map(paths.map((path) => [path, segments(path).map(({ part, group }) => ids.get(group)!.size > 1 ? part : part.replace(NOTION_ID, ''))
    .join('/') + (path.endsWith('/') ? '/' : '')]));
}

/** Resolve relative links against the archive so they follow the same renames as their targets. */
function rewriteNotionLinks(markdown: string, original: string, paths: Map<string, string>): string {
  const from = posix.dirname(`/${paths.get(original)!}`);
  const normalize = (target: string): string => {
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#')) return target;
    const match = target.match(/^([^?#]*)(.*)$/)!;
    let decoded: string;
    try { decoded = decodeURIComponent(match[1]!).normalize('NFC'); }
    catch { return fail('Invalid encoded Notion link'); }
    const mapped = paths.get(posix.join(posix.dirname(original), decoded));
    return markdownHref(mapped === undefined ? notionPath(decoded) : posix.relative(from, `/${mapped}`)) + match[2];
  };
  // Notion keeps `[`/`]` in link text (`[[보상] 제목](…)`) and percent-encodes `(` but not `)` in targets
  // (`%28해외)%20<id>.md`), so a target may span literal `)` when it still ends in a file extension.
  return markdown.replace(/(!?\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\()(<[^>]+>|[^\s)]*(?:\)[^\s()[\]]+)*\.[A-Za-z\d]+(?:[?#][^\s)]*)?(?=\))|[^\s)]+)([^)]*\))/g, (_, open: string, target: string, close: string) =>
    `${open}${target.startsWith('<') ? `<${normalize(target.slice(1, -1))}>` : normalize(target)}${close}`)
    .replace(/^(\s*\[[^\]\n]+\]:\s*)(<[^>]+>|\S+)/gm, (_, open: string, target: string) =>
      `${open}${target.startsWith('<') ? `<${normalize(target.slice(1, -1))}>` : normalize(target)}`)
    .replace(/(!?\[\[)([^\]\n]+)(\]\])/g, (_, open: string, target: string, close: string) => {
      const [path, ...alias] = target.split('|');
      return `${open}${notionPath(path!)}${alias.length ? `|${alias.join('|')}` : ''}${close}`;
    });
}

/** Inspect the central directory before inflating; never materialize entries on disk. */
function inspectZip(buffer: Buffer): Map<string, number> {
  if (buffer.length > VAULT_BYTES) throw new ApiError(413, 'source_too_large', 'ZIP exceeds 100 MiB');
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) { end = at; break; }
  }
  if (end < 0) fail('Invalid ZIP directory');
  const count = buffer.readUInt16LE(end + 10);
  if (count > VAULT_FILES || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count) fail('ZIP entry limit or unsupported multi-disk ZIP');
  const entries = new Map<string, number>();
  let offset = buffer.readUInt32LE(end + 16);
  const directoryEnd = offset + buffer.readUInt32LE(end + 12);
  if (directoryEnd !== end) fail('Unsupported ZIP64 or invalid directory');
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) fail('Invalid ZIP entry');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 24);
    const length = buffer.readUInt16LE(offset + 28);
    const next = offset + 46 + length + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    if (next > end || (flags & 1) || ![0, 8].includes(method) || ((buffer.readUInt32LE(offset + 38) >>> 16) & 0xf000) === 0xa000) fail('Encrypted, symlink or unsupported ZIP entry');
    const path = safeArchivePath(decodeText(buffer.subarray(offset + 46, offset + 46 + length)));
    if (entries.has(path)) fail('Duplicate ZIP entry');
    total += size;
    if (size > SOURCE_BYTES || total > VAULT_BYTES) throw new ApiError(413, 'source_too_large', 'ZIP expanded size exceeds the limit');
    entries.set(path, size);
    offset = next;
  }
  if (offset !== directoryEnd) fail('Invalid ZIP directory size');
  return entries;
}

export function extractVault(buffer: Buffer, kind: 'obsidian' | 'notion'): Extraction {
  const expected = inspectZip(buffer);
  const paths = kind === 'notion' ? notionPaths(expected.keys()) : undefined;
  const files: ExtractedFile[] = [];
  const seen = new Set<string>();
  const consumed = new Set<string>();
  let total = 0;
  let completed = 0;
  const unzip = new Unzip((file) => {
    const original = safeArchivePath(file.name);
    const size = expected.get(original);
    if (size === undefined || consumed.has(original)) fail('ZIP local entries differ from the directory');
    consumed.add(original);
    const path = paths ? safeArchivePath(paths.get(original)!) : original;
    // Invariant guard: renaming must never merge two entries into one path.
    if (seen.has(path)) fail('Normalized ZIP paths collide');
    seen.add(path);
    let actual = 0;
    const chunks: Buffer[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) fail('ZIP entry could not be decoded');
      actual += chunk.length;
      total += chunk.length;
      if (actual > size || total > VAULT_BYTES) throw new ApiError(413, 'source_too_large', 'ZIP expanded size exceeds its declared limit');
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (final) {
        if (actual !== size) fail('ZIP entry has an invalid size');
        completed++;
        if (path.endsWith('/')) return;
        // Internal vault metadata is not knowledge or an attachment.
        if (path.split('/').some((part) => part.startsWith('.')) || path.startsWith('__MACOSX/')) return;
        const markdown = /\.md$/i.test(path);
        let content = Buffer.concat(chunks, actual);
        if (markdown) content = Buffer.from(paths ? rewriteNotionLinks(decodeText(content), original, paths) : decodeText(content));
        files.push({ path, buffer: content, markdown });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small compressed chunks also bound transient inflater allocations for forged sizes.
  try {
    for (let at = 0; at < buffer.length; at += 4096) unzip.push(buffer.subarray(at, at + 4096), at + 4096 >= buffer.length);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail('ZIP could not be decoded');
  }
  if (consumed.size !== expected.size || completed !== expected.size || !files.some((file) => file.markdown)) fail('ZIP must contain complete Markdown notes');
  files.sort((a, b) => a.path.localeCompare(b.path));
  const notes = files.filter((file) => file.markdown);
  return {
    title: kind === 'notion' ? 'Notion export' : 'Obsidian vault',
    markdown: notes.map((file) => `- [${posix.basename(file.path).replace(/[\[\]\\]/g, '\\$&')}](<${markdownHref(`files/${file.path}`)}>)`).join('\n'), files,
  };
}
