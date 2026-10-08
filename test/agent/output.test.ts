import { describe, expect, it } from 'vitest';
import { capOutput, pageContent, PAGE_MAX_CHARS, SUBAGENT_MAX_CHARS, TOOL_MAX_CHARS } from '../../src/agent/output.js';

describe('bounded agent output', () => {
  it('uses zero-based lines and preserves delimiters across line-limited pages', () => {
    const original = '# First\r\nfirst\r\n# Second\nsecond\n';
    const first = pageContent(original, 0, 2);
    expect(first).toEqual({ content: '# First\r\nfirst\r\n', totalLines: 4, nextOffset: 2, truncated: true });
    const second = pageContent(original, first.nextOffset!, 2);
    expect(second).toEqual({ content: '# Second\nsecond\n', totalLines: 4, nextOffset: null, truncated: false });
    expect(first.content + second.content).toBe(original);
  });

  it('caps a page at 800 physical lines even when the caller requests more', () => {
    const original = 'line\n'.repeat(801);
    const first = pageContent(original, 0, 1000);
    expect(first.content).toBe('line\n'.repeat(800));
    expect(first.nextOffset).toBe(800);
    expect(first.totalLines).toBe(801);
    expect(first.content + pageContent(original, 800).content).toBe(original);
  });

  it.each([
    'A'.repeat(70_001),
    '\\"\u0000\t'.repeat(15_001),
    '🧠'.repeat(20_001),
  ])('retrieves every character of a long line without overrunning raw or serialized limits', (longLine) => {
    const original = `prefix\r\n${longLine}\r\nlast\n`;
    let offset: number | null = 0;
    let charOffset = 0;
    let reconstructed = '';
    const continuations: number[] = [];
    for (let pages = 0; offset !== null; pages++) {
      if (pages > 100) throw new Error('Paging failed to advance');
      const page = pageContent(original, offset, 800, charOffset);
      expect(page.content.length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
      expect(JSON.stringify(page.content).length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
      reconstructed += page.content;
      offset = page.nextOffset;
      charOffset = page.nextCharOffset ?? 0;
      if (charOffset) continuations.push(offset!);
    }
    expect(reconstructed).toBe(original);
    expect(continuations.every((line) => line === 1)).toBe(true);
    expect(continuations.length).toBeGreaterThan(0);
  });

  it('distinguishes empty content and exhausted offsets from a truncated page', () => {
    expect(pageContent('')).toEqual({ content: '', totalLines: 0, nextOffset: null, truncated: false });
    expect(pageContent('one\n', 1)).toEqual({ content: '', totalLines: 1, nextOffset: null, truncated: false });
    expect(pageContent('\n')).toEqual({ content: '\n', totalLines: 1, nextOffset: null, truncated: false });
  });

  it.each([TOOL_MAX_CHARS, SUBAGENT_MAX_CHARS])('caps oversized outputs at %i while explaining how to retrieve more', (maximum) => {
    const exact = 'a'.repeat(maximum);
    expect(capOutput(exact, maximum)).toBe(exact);
    const capped = capOutput(exact + 'private tail', maximum);
    expect(capped.length).toBe(maximum);
    expect(capped).toContain('truncated');
    expect(capped).toContain('paging or narrower queries');
    expect(capped).not.toContain('private tail');
  });
});
