import { describe, expect, it } from 'vitest';
import { chunkNote, normalizedNoteHash } from './chunking.js';


it('matches rendered wikilink aliases, inline code and math heading IDs', () => {
  const chunks = chunkNote('wiki/note.md', '## [[Target|Visible alias]] and `[[Literal]]` $x^2$\nBody\n\n## [[Target|Visible alias]] and `[[Literal]]` $x^2$\nAgain');
  expect(chunks.map((chunk) => chunk.anchor)).toEqual([
    'visible-alias-and-literal-x2', 'visible-alias-and-literal-x2-1',
  ]);
});
describe('upgraded note chunks', () => {
  it('uses rendered Markdown heading text and document-wide duplicate slugs', () => {
    const body = '# Document\n\n## **Hello** [world](https://example.test) &amp; `code`\nFirst.\n\n## Hello world & code\nSecond.\n\nHello world & code\n------------------\nThird.\n\n### 한국어 🌙\nFourth.\n\n```md\n## Hello world & code\n```\n\n## Hello world & code\nLast.';
    const chunks = chunkNote('wiki/note.md', body);
    expect(chunks.map((chunk) => chunk.anchor)).toEqual([
      'document', 'hello-world--code', 'hello-world--code-1', 'hello-world--code-2', '한국어-', 'hello-world--code-3',
    ]);
    expect(chunks[1]!.heading).toBe('Hello world & code');
    expect(chunks[4]!.heading).toBe('Hello world & code > 한국어 🌙');
  });

  it('keeps raw UTF-16 offsets after CRLF frontmatter and astral characters', () => {
    const markdown = '---\r\ntags: ["#Ｓｅａｒｃｈ", SEARCH, "한국어", 12]\r\n---\r\n# 🌙 Note\r\n\r\n## Section\r\n'
      + '첫 문장 🌙. 다음 문장.\r\n\r\n'.repeat(240);
    const chunks = chunkNote('wiki/note.md', markdown);
    expect(chunks[0]!.tags).toEqual(['search', '한국어']);
    expect(chunks[0]!.sourceStart).toBe(markdown.indexOf('# 🌙'));
    expect(chunks.at(-1)!.sourceEnd).toBe(markdown.length);
    for (const chunk of chunks) {
      expect(markdown.slice(chunk.sourceStart, chunk.sourceEnd)).toBe(chunk.content);
      expect(chunk.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    const sectionChunks = chunks.filter((chunk) => chunk.anchor === 'section');
    for (let index = 1; index < sectionChunks.length; index++) {
      const current = sectionChunks[index]!;
      const previous = sectionChunks[index - 1]!;
      const overlap = markdown.slice(current.sourceStart, previous.sourceEnd);
      expect(overlap).toMatch(/^(?:첫 문장 🌙\. 다음 문장\.\r\n\r\n)+$/);
      expect(overlap.length).toBeLessThanOrEqual(320);
      expect(current.sourceEnd).toBeGreaterThan(previous.sourceEnd);
    }
  });

  it('identifies notes differing only by Unicode compatibility, newline style and trailing whitespace', () => {
    expect(normalizedNoteHash('\n# Ｎｏｔｅ  \r\nBody\t\r\n')).toBe(normalizedNoteHash('# Note\nBody'));
    expect(normalizedNoteHash('# Note\nDifferent body')).not.toBe(normalizedNoteHash('# Note\nBody'));
  });
});
