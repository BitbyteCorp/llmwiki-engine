import { describe, expect, it } from 'vitest';
import { planBatches } from './batches.js';

describe('planBatches', () => {
  it('packs up to the exact default character budget before splitting', () => {
    expect(planBatches([
      { path: 'd.md', chars: 119_999 },
      { path: 'b.md', chars: 60_000 },
      { path: 'a.md', chars: 60_000 },
      { path: 'c.md', chars: 1 },
    ])).toEqual([['a.md', 'b.md'], ['c.md', 'd.md']]);
  });

  it('splits contiguous files at the configured file count', () => {
    expect(planBatches([
      { path: 'e.md', chars: 1 },
      { path: 'c.md', chars: 1 },
      { path: 'a.md', chars: 1 },
      { path: 'd.md', chars: 1 },
      { path: 'b.md', chars: 1 },
    ], { maxFiles: 2 })).toEqual([['a.md', 'b.md'], ['c.md', 'd.md'], ['e.md']]);
  });

  it('keeps an oversized file alone without consuming its following files', () => {
    expect(planBatches([
      { path: 'a.md', chars: 2 },
      { path: 'b.md', chars: 11 },
      { path: 'c.md', chars: 0 },
      { path: 'd.md', chars: 2 },
    ], { maxChars: 10 })).toEqual([['a.md'], ['b.md'], ['c.md', 'd.md']]);
  });

  it('does not skip a file to fill an earlier batch', () => {
    expect(planBatches([
      { path: 'a.md', chars: 6 },
      { path: 'b.md', chars: 5 },
      { path: 'c.md', chars: 4 },
    ], { maxChars: 10 })).toEqual([['a.md'], ['b.md', 'c.md']]);
  });

  it('groups siblings with each page immediately before its nested folder', () => {
    const files = [
      'Z.md',
      'X/Child/Nested.md',
      'X-other.md',
      'X/Alpha.md',
      'X.md',
      'X/Child.md',
      'XY.md',
      'A/Last.md',
      'A.md',
      'X/Zebra.md',
    ].map((path) => ({ path, chars: 1 }));
    const original = files.map((file) => ({ ...file }));
    const expected = [[
      'A.md',
      'A/Last.md',
      'X.md',
      'X/Alpha.md',
      'X/Child.md',
      'X/Child/Nested.md',
      'X/Zebra.md',
      'X-other.md',
      'XY.md',
      'Z.md',
    ]];
    expect(planBatches(files)).toEqual(expected);
    expect(planBatches([...files].reverse())).toEqual(expected);
    expect(files).toEqual(original);
  });

  it('returns no batches when there are no files', () => {
    expect(planBatches([])).toEqual([]);
  });
});
