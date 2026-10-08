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

  it.each([undefined, 1000])('caps default and oversized requests at 300 physical lines', (limit) => {
    const original = 'line\n'.repeat(301);
    const first = pageContent(original, 0, limit);
    expect(first.content).toBe('line\n'.repeat(300));
    expect(first.nextOffset).toBe(300);
    expect(first.totalLines).toBe(301);
    expect(first.content + pageContent(original, 300).content).toBe(original);
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
      const page = pageContent(original, offset, undefined, charOffset);
      expect(page.content.length).toBeLessThanOrEqual(12_000);
      expect(JSON.stringify(page.content).length).toBeLessThanOrEqual(12_000);
      reconstructed += page.content;
      offset = page.nextOffset;
      charOffset = page.nextCharOffset ?? 0;
      if (charOffset) continuations.push(offset!);
    }
    expect(reconstructed).toBe(original);
    expect(continuations.every((line) => line === 1)).toBe(true);
    expect(continuations.length).toBeGreaterThan(0);
  });

  it('finishes a line exactly at the serialized page boundary and resumes one character beyond it', () => {
    const exact = 'a'.repeat(PAGE_MAX_CHARS - 2);
    expect(pageContent(exact)).toEqual({ content: exact, totalLines: 1, nextOffset: null, truncated: false });
    const first = pageContent(exact + 'b');
    expect(first).toEqual({ content: exact, totalLines: 1, nextOffset: 0, nextCharOffset: exact.length, truncated: true });
    expect(pageContent(exact + 'b', first.nextOffset!, undefined, first.nextCharOffset)).toEqual({
      content: 'b', totalLines: 1, nextOffset: null, truncated: false,
    });
  });

  it('distinguishes empty content and exhausted offsets from a truncated page', () => {
    expect(pageContent('')).toEqual({ content: '', totalLines: 0, nextOffset: null, truncated: false });
    expect(pageContent('one\n', 1)).toEqual({ content: '', totalLines: 1, nextOffset: null, truncated: false });
    expect(pageContent('\n')).toEqual({ content: '\n', totalLines: 1, nextOffset: null, truncated: false });
  });

  it.each([TOOL_MAX_CHARS, SUBAGENT_MAX_CHARS])('caps oversized outputs at %i without leaking the discarded tail', (maximum) => {
    const exact = 'a'.repeat(maximum);
    expect(capOutput(exact, maximum)).toBe(exact);
    const capped = capOutput(exact + 'private tail', maximum);
    expect(capped.length).toBe(maximum);
    expect(capped).not.toContain('private tail');
  });

  it('applies the 16000-character generic cap when no narrower cap is supplied', () => {
    const exact = 'a'.repeat(16_000);
    expect(capOutput(exact)).toBe(exact);
    const capped = capOutput(exact + 'private tail');
    expect(capped.length).toBe(16_000);
    expect(capped).not.toContain('private tail');
  });
});
