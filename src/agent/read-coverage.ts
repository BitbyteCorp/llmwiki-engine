import { repoPath } from '../knowledge/repo.js';
import type { ContentPage } from './output.js';

type Position = { line: number; char: number };
type Interval = { start: Position; end: Position };

function compare(left: Position, right: Position): number {
  return left.line - right.line || left.char - right.char;
}

/** Tracks only the ranges returned by successful reads of immutable sources. */
export class ReadCoverage {
  readonly total: number;
  private readonly ranges = new Map<string, Interval[] | null>();

  constructor(requiredPaths: string[]) {
    for (const path of requiredPaths) this.ranges.set(repoPath(path), []);
    this.total = this.ranges.size;
  }

  record(path: string, source: string, page: ContentPage, options: { offset?: number; charOffset?: number }): void {
    path = repoPath(path);
    const ranges = this.ranges.get(path);
    if (!ranges) return;
    if (source.length === 0) {
      this.ranges.set(path, null);
      return;
    }

    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    if (offset >= page.totalLines || page.content.length === 0) return;

    let lineStart = 0;
    for (let line = 0; line < offset; line++) lineStart = source.indexOf('\n', lineStart) + 1;
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const charOffset = Math.max(0, Math.trunc(options.charOffset ?? 0));
    let position = Math.min(lineStart + charOffset, lineEnd);
    const previous = source.charCodeAt(position - 1);
    const current = source.charCodeAt(position);
    if (previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF) position--;

    let start: Position = position === lineEnd
      ? { line: offset + 1, char: 0 }
      : { line: offset, char: position - lineStart };
    let end: Position = { line: page.nextOffset ?? page.totalLines, char: page.nextCharOffset ?? 0 };
    if (compare(start, end) >= 0) return;

    let first = 0;
    while (first < ranges.length && compare(ranges[first]!.end, start) < 0) first++;
    let last = first;
    while (last < ranges.length && compare(ranges[last]!.start, end) <= 0) {
      const range = ranges[last]!;
      if (compare(range.start, start) < 0) start = range.start;
      if (compare(range.end, end) > 0) end = range.end;
      last++;
    }
    ranges.splice(first, last - first, { start, end });
    if (start.line === 0 && start.char === 0 && end.line === page.totalLines && end.char === 0) this.ranges.set(path, null);
  }

  unread(): string[] {
    const paths: string[] = [];
    for (const [path, ranges] of this.ranges) if (ranges !== null) paths.push(path);
    return paths;
  }
}
