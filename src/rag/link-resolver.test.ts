import { describe, expect, it } from 'vitest';
import { normalizeLinkTarget, NoteTargetResolver, resolveNoteTarget } from './link-resolver.js';

const files: readonly string[] = ['Wiki/Topic.md', 'Archive/TOPIC.MD', 'Wiki/Nested/Unique.md'];

describe('shared note link resolution', () => {
  it.each([
    ['  Wiki/Topic.MD  #Overview|Display label', 'wiki/topic'],
    ['  Wiki/Topic.md  |Display #label', 'wiki/topic'],
    ['  Topic  ', 'topic'],
    ['Wiki/Nested/Unique', 'wiki/nested/unique'],
  ])('normalizes %s without discarding its folder', (target, expected) => {
    expect(normalizeLinkTarget(target)).toBe(expected);
  });

  it('leaves duplicate basenames ambiguous and sorts the original candidate paths', () => {
    expect(resolveNoteTarget('  tOpIc.Md  |Label', files)).toEqual({
      path: null, candidates: ['Archive/TOPIC.MD', 'Wiki/Topic.md'],
    });
  });

  it('resolves a qualified mixed-case target with suffix, whitespace and fragment', () => {
    expect(resolveNoteTarget('  wIkI/tOpIc.MD  #Overview|Label', files)).toEqual({
      path: 'Wiki/Topic.md', candidates: ['Wiki/Topic.md'],
    });
  });

  it('resolves a unique basename from a nested folder', () => {
    expect(resolveNoteTarget('  UNIQUE  ', files)).toEqual({
      path: 'Wiki/Nested/Unique.md', candidates: ['Wiki/Nested/Unique.md'],
    });
  });

  it.each(['Missing', 'Wrong/Topic', '  #Overview'])('returns no candidates for %s', (target) => {
    expect(resolveNoteTarget(target, files)).toEqual({ path: null, candidates: [] });
  });

  it('keeps case-colliding qualified paths ambiguous instead of choosing the first', () => {
    expect(resolveNoteTarget('wiki/topic', ['wiki/topic.md', 'Wiki/Topic.md'])).toEqual({
      path: null, candidates: ['Wiki/Topic.md', 'wiki/topic.md'],
    });
  });

  it('reuses a snapshot across ambiguous, qualified and missing target lookups', () => {
    const resolver = new NoteTargetResolver(files);
    expect(resolver.resolve('TOPIC')).toEqual({
      path: null, candidates: ['Archive/TOPIC.MD', 'Wiki/Topic.md'],
    });
    expect(resolver.resolve(' archive/topic.MD |Alias')).toEqual({
      path: 'Archive/TOPIC.MD', candidates: ['Archive/TOPIC.MD'],
    });
    expect(resolver.resolve('Other/Topic')).toEqual({ path: null, candidates: [] });
    expect(resolver.resolve('Unique#Section')).toEqual({
      path: 'Wiki/Nested/Unique.md', candidates: ['Wiki/Nested/Unique.md'],
    });
  });
});
