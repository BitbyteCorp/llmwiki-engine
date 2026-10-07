import { describe, expect, it } from 'vitest';
import { chunkNote, kindForPath, wikilinkTargets } from './chunking.js';

describe('note chunking', () => {
  it.each([
    ['---\ntitle: Frontmatter title\n---\n# Heading title\nBody', 'Frontmatter title'],
    ['---\ntitle: " "\n---\n# Heading title ###\nBody', 'Heading title'],
    ['# First title\nBody\n# Later title\nMore body', 'First title'],
    ['---\ntitle: 42\n---\n# Heading title\nBody', 'Heading title'],
    ['No heading here.', 'fallback'],
  ])('chooses a title by frontmatter, H1, then filename precedence', (markdown, title) => {
    expect(chunkNote('wiki/fallback.md', markdown).map((chunk) => chunk.title)).toEqual([title]);
  });

  it('keeps H2 context for H3 sections and resets it at the next H2', () => {
    const body = '# Storage\nIntroduction.\n\n## Search\nOverview.\n\n### Korean\n한국어 검색.\n\n### English\nEnglish search.\n\n## Links\nConnected notes.\n';
    const chunks = chunkNote('wiki/storage.md', body);
    expect(chunks.map((chunk) => chunk.heading)).toEqual([
      '', 'Search', 'Search > Korean', 'Search > English', 'Links',
    ]);
    expect(chunks[2]!.embeddingText).toBe('Storage > Search > Korean\n\n### Korean\n한국어 검색.\n\n');
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(body);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2, 3, 4]);
  });

  it('uses frontmatter tags as embedding context without indexing frontmatter as body', () => {
    const chunks = chunkNote('wiki/note.md', '---\ntitle: Note\ntags:\n  - search\n  - 한국어\n  - search\nsecret: do-not-index\n---\n## Section\nBody.\n');
    expect(chunks[0]!.content).toBe('## Section\nBody.\n');
    expect(chunks[0]!.embeddingText).toBe('Note > Section\n태그: search, 한국어\n\n## Section\nBody.\n');
    expect(chunkNote('wiki/note.md', '---\ntags: search, korean\n---\nBody')[0]!.embeddingText)
      .toBe('note\n태그: search, korean\n\nBody');
  });

  it('invalidates semantic cache entries when only title, tags, or ancestor context changes', () => {
    const note = (title: string, tags: string) => `---\ntitle: ${title}\ntags: [${tags}]\n---\nBody`;
    const original = chunkNote('wiki/note.md', note('Original', 'search'))[0]!;
    const changedTitle = chunkNote('wiki/note.md', note('Changed', 'search'))[0]!;
    const changedTags = chunkNote('wiki/note.md', note('Original', 'links'))[0]!;
    expect(changedTitle.content).toBe(original.content);
    expect(changedTitle.contentHash).not.toBe(original.contentHash);
    expect(changedTags.content).toBe(original.content);
    expect(changedTags.contentHash).not.toBe(original.contentHash);
    expect(chunkNote('wiki/note.md', note('Original', 'search'))[0]!.contentHash).toBe(original.contentHash);

    const underSearch = chunkNote('wiki/note.md', '## Search\n### Details\nShared body')[1]!;
    const underLinks = chunkNote('wiki/note.md', '## Links\n### Details\nShared body')[1]!;
    expect(underLinks.content).toBe(underSearch.content);
    expect(underLinks.contentHash).not.toBe(underSearch.contentHash);
  });

  it.each([
    ['prose', 'A sentence with spaces.\n\n'.repeat(700), 3200],
    ['unbroken text', 'x'.repeat(10001), 3200],
    ['Korean', '한국어 검색은 문맥을 보존한다.\n'.repeat(700), 1400],
    ['astral code points', '🌙'.repeat(2401), 1611],
  ])('bounds long %s sections and preserves every character', (_name, text, maxLength) => {
    const body = `## Section\n${text}`;
    const chunks = chunkNote('wiki/note.md', body);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(body);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(maxLength);
      expect(chunk.heading).toBe('Section');
      expect(chunk.embeddingText.startsWith('note > Section\n\n')).toBe(true);
      expect(chunk.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it('ignores heading-like lines inside backtick and tilde fences, including mismatched closers', () => {
    const body = '````markdown\n# Fake title\n## Fake section\n```\n### Still fenced\n````\n# Real title\n## Actual\n~~~text\n### Fake child\n```\n## Still fenced\n~~~~\n### Real child\nBody\n';
    const chunks = chunkNote('wiki/fallback.md', body);
    expect(chunks.map((chunk) => chunk.title)).toEqual(['Real title', 'Real title', 'Real title']);
    expect(chunks.map((chunk) => chunk.heading)).toEqual(['', 'Actual', 'Actual > Real child']);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(body);
  });

  it('does not treat indented code or inline hash text as headings', () => {
    const body = '    # Not a title\n    ## Not a section\n##Not a heading\nText ### not a heading\n';
    const chunks = chunkNote('wiki/fallback.md', body);
    expect(chunks[0]!.title).toBe('fallback');
    expect(chunks[0]!.heading).toBe('');
    expect(chunks[0]!.content).toBe(body);
  });

  it('does not index empty or frontmatter-only notes', () => {
    expect(chunkNote('wiki/empty.md', '')).toEqual([]);
    expect(chunkNote('wiki/empty.md', '---\ntitle: Empty\ntags: [search]\n---\n\n')).toEqual([]);
  });
});

describe('knowledge path kinds', () => {
  it.each([
    ['wiki/nested/note.md', 'wiki'], ['journal/2026-10-07.md', 'journal'],
    ['raw/source.md', 'raw'], ['index.md', 'other'], ['elsewhere/wiki/note.md', 'other'],
    ['wiki.md', 'other'],
  ])('classifies %s as %s', (path, kind) => {
    expect(kindForPath(path)).toBe(kind);
    expect(chunkNote(path, 'Body')[0]!.kind).toBe(kind);
  });
});

describe('wikilink targets', () => {
  it('normalizes basenames, extension, case, aliases and anchors while deduplicating', () => {
    const markdown = '[[wiki/Note.md#Heading|Alias]] [[NOTE]] [[folder/note.MD|Another]] '
      + '[[ Journal/Other.md | Label ]] [[Other#^block]] ![[raw/한국어.md#문맥]] '
      + '[[#Local heading]] [[ | Empty ]] [[third#Part|Name]]';
    expect(wikilinkTargets(markdown)).toEqual(['note', 'other', '한국어', 'third']);
  });
});
