export const PAGE_MAX_LINES = 300;
export const PAGE_MAX_CHARS = 12_000;
export const TOOL_MAX_CHARS = 16_000;
export const SUBAGENT_MAX_CHARS = 8_000;

export interface ContentPage {
  content: string;
  totalLines: number;
  nextOffset: number | null;
  truncated: boolean;
  nextCharOffset?: number;
}

/** Offsets count physical lines; charOffset resumes a character-limited line. */
export function pageContent(content: string, offset = 0, limit = PAGE_MAX_LINES, charOffset = 0): ContentPage {
  offset = Math.max(0, Math.trunc(offset));
  limit = Math.max(1, Math.min(PAGE_MAX_LINES, Math.trunc(limit)));
  charOffset = Math.max(0, Math.trunc(charOffset));
  let totalLines = 0;
  let start = content.length;
  for (let index = 0; index < content.length; index++) {
    if (index === 0 || content[index - 1] === '\n') {
      if (totalLines === offset) start = index;
      totalLines++;
    }
  }
  if (offset >= totalLines) return { content: '', totalLines, nextOffset: null, truncated: false };

  let line = offset;
  let lineStart = start;
  const firstNewline = content.indexOf('\n', start);
  const firstLineEnd = firstNewline < 0 ? content.length : firstNewline + 1;
  let position = Math.min(start + charOffset, firstLineEnd);
  if (position === firstLineEnd) line++;
  start = position;
  let end = start;
  let lines = 0;
  if (position === firstLineEnd) lineStart = position;
  let jsonChars = 2;
  while (position < content.length && lines < limit) {
    const newline = content.indexOf('\n', position);
    const lineEnd = newline < 0 ? content.length : newline + 1;
    const available = PAGE_MAX_CHARS - (end - start);
    const rawEnd = Math.min(lineEnd, position + available);
    end = position;
    while (end < rawEnd) {
      const code = content.charCodeAt(end);
      const cost = code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2
        : code < 32 || (code >= 0xD800 && code <= 0xDFFF) ? 6 : 1;
      if (jsonChars + cost > PAGE_MAX_CHARS) break;
      jsonChars += cost;
      end++;
    }
    if (end < lineEnd) {
      return { content: content.slice(start, end), totalLines, nextOffset: line, nextCharOffset: end - lineStart, truncated: true };
    }
    position = end;
    lineStart = end;
    line++;
    lines++;
    if (end - start === PAGE_MAX_CHARS) break;
  }
  const truncated = end < content.length;
  return { content: content.slice(start, end), totalLines, nextOffset: truncated ? line : null, truncated };
}

export function capOutput(value: string, maxChars = TOOL_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  const marker = '\n[truncated: use paging or narrower queries to retrieve more.]';
  return value.slice(0, Math.max(0, maxChars - marker.length)) + marker.slice(0, maxChars);
}
