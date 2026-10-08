import { describe, expect, it } from 'vitest';
import { pageContent } from '../../src/agent/output.js';
import { ReadCoverage } from '../../src/agent/read-coverage.js';

describe('required source read coverage', () => {
  it('requires every physical line even when pages arrive out of order or overlap', () => {
    const source = 'first\r\nsecond\nthird\nlast';
    const coverage = new ReadCoverage(['raw/source.md']);

    coverage.record('raw/source.md', source, pageContent(source, 2, 2), { offset: 2 });
    coverage.record('raw/source.md', source, pageContent(source, 0, 1), {});
    coverage.record('raw/source.md', source, pageContent(source, 2, 2), { offset: 2 });
    expect(coverage.unread()).toEqual(['raw/source.md']);

    coverage.record('raw/source.md', source, pageContent(source, 1, 2), { offset: 1 });
    expect(coverage.unread()).toEqual([]);
  });

  it('keeps character gaps unread even after receiving the start and end of a long line', () => {
    const source = 'a'.repeat(30_000);
    const coverage = new ReadCoverage(['raw/long.md']);
    coverage.record('raw/long.md', source, pageContent(source, 0, undefined, 24_000), { charOffset: 24_000 });
    coverage.record('raw/long.md', source, pageContent(source), {});
    coverage.record('raw/long.md', source, pageContent(source, 0, undefined, 12_000), { charOffset: 12_000 });
    expect(coverage.unread()).toEqual(['raw/long.md']);

    coverage.record('raw/long.md', source, pageContent(source, 0, undefined, 11_998), { charOffset: 11_998 });
    expect(coverage.unread()).toEqual(['raw/long.md']);
    coverage.record('raw/long.md', source, pageContent(source, 0, undefined, 23_998), { charOffset: 23_998 });
    expect(coverage.unread()).toEqual([]);
  });

  it('joins character continuations with physical line ranges across escaped content', () => {
    const source = `prefix\r\n${'\u0000🧠'.repeat(4_000)}\r\nlast\n`;
    const coverage = new ReadCoverage(['raw/escaped.md']);
    const first = pageContent(source);
    const secondOptions = { offset: first.nextOffset!, charOffset: first.nextCharOffset };
    const second = pageContent(source, secondOptions.offset, undefined, secondOptions.charOffset);
    const lastOptions = { offset: second.nextOffset!, charOffset: second.nextCharOffset };
    coverage.record('raw/escaped.md', source, pageContent(source, lastOptions.offset, undefined, lastOptions.charOffset), lastOptions);
    coverage.record('raw/escaped.md', source, first, {});
    expect(coverage.unread()).toEqual(['raw/escaped.md']);
    coverage.record('raw/escaped.md', source, second, secondOptions);
    expect(coverage.unread()).toEqual([]);
  });

  it('backs a character offset inside an emoji up to the returned code point', () => {
    const source = 'prefix\n🧠tail';
    const coverage = new ReadCoverage(['raw/emoji.md']);
    coverage.record('raw/emoji.md', source, pageContent(source, 0, 1), {});
    coverage.record('raw/emoji.md', source, pageContent(source, 1, undefined, 1), { offset: 1, charOffset: 1 });
    expect(coverage.unread()).toEqual([]);
  });

  it.each([8, 9, 100_000])('clips charOffset %i to the initial line without counting skipped content', (charOffset) => {
    const source = 'skipped\nkept\n';
    const coverage = new ReadCoverage(['raw/clipped.md']);
    coverage.record('raw/clipped.md', source, pageContent(source, 0, undefined, charOffset), { charOffset });
    expect(coverage.unread()).toEqual(['raw/clipped.md']);
    coverage.record('raw/clipped.md', source, pageContent(source, 0, 1), {});
    expect(coverage.unread()).toEqual([]);
  });

  it('matches negative and fractional read offsets after clipping', () => {
    const source = 'first\nsecond';
    const coverage = new ReadCoverage(['raw/offsets.md']);
    coverage.record('raw/offsets.md', source, pageContent(source, 1.9, undefined, -2.5), { offset: 1.9, charOffset: -2.5 });
    expect(coverage.unread()).toEqual(['raw/offsets.md']);
    coverage.record('raw/offsets.md', source, pageContent(source, -1.5, 1, -1), { offset: -1.5, charOffset: -1 });
    expect(coverage.unread()).toEqual([]);
  });

  it.each(['one', 'one\n', '\n', 'one\n\n'])('does not count an exhausted read as coverage for %j', (source) => {
    const coverage = new ReadCoverage(['raw/exhausted.md']);
    const totalLines = pageContent(source).totalLines;
    coverage.record('raw/exhausted.md', source, pageContent(source, totalLines), { offset: totalLines });
    coverage.record('raw/exhausted.md', source, pageContent(source, totalLines + 100), { offset: totalLines + 100 });
    coverage.record('raw/exhausted.md', source, pageContent(source, totalLines - 1, undefined, 100), { offset: totalLines - 1, charOffset: 100 });
    expect(coverage.unread()).toEqual(['raw/exhausted.md']);
    coverage.record('raw/exhausted.md', source, pageContent(source), {});
    expect(coverage.unread()).toEqual([]);
  });

  it('requires one successful read for an empty source', () => {
    const coverage = new ReadCoverage(['raw/empty.md']);
    expect(coverage.unread()).toEqual(['raw/empty.md']);
    coverage.record('raw/empty.md', '', pageContent('', 100), { offset: 100 });
    expect(coverage.unread()).toEqual([]);
  });

  it('canonicalizes aliases, deduplicates requirements, and reports only assigned unread paths in order', () => {
    const coverage = new ReadCoverage(['./raw//b.md', 'raw/a.md', 'raw/./b.md', 'raw/c.md']);
    expect(coverage.total).toBe(3);
    expect(coverage.unread()).toEqual(['raw/b.md', 'raw/a.md', 'raw/c.md']);
    coverage.record('raw/unassigned.md', 'other', pageContent('other'), {});
    coverage.record('./raw//a.md', 'complete', pageContent('complete'), {});
    expect(coverage.unread()).toEqual(['raw/b.md', 'raw/c.md']);
    coverage.record('raw/b.md', 'complete', pageContent('complete'), {});
    coverage.record('raw/./c.md', 'complete', pageContent('complete'), {});
    expect(coverage.unread()).toEqual([]);
    expect(coverage.total).toBe(3);
  });

  it('keeps canonically equivalent Unicode filesystem names distinct', () => {
    const coverage = new ReadCoverage(['raw/é.md', 'raw/e\u0301.md']);
    coverage.record('raw/é.md', 'source', pageContent('source'), {});
    expect(coverage.total).toBe(2);
    expect(coverage.unread()).toEqual(['raw/e\u0301.md']);
    coverage.record('raw/e\u0301.md', 'source', pageContent('source'), {});
    expect(coverage.unread()).toEqual([]);
  });
});
