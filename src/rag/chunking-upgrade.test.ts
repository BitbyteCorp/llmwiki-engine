import { describe, expect, it, vi } from 'vitest';
import { chunkNote, normalizedNoteHash, type NoteChunk } from './chunking.js';


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

  it('keeps GFM references, footnote numbering and inline HTML heading semantics', () => {
    const markdown = '# Document\n\nFirst[^first].\n\n'
      + '## [**Same**][label] ~~text~~ <i>raw</i> $x$\nBody.\n\n'
      + '| Heading-like cell |\n| --- |\n| ## Not a section |\n\n'
      + '## Shared[^second]\nBody.\n\n## Shared2\nAgain.\n\n'
      + '[label]: https://example.test\n[^first]: First footnote.\n[^second]: Second footnote.\n';
    const chunks = chunkNote('wiki/note.md', markdown);
    expect(chunks.map((chunk) => chunk.anchor)).toEqual([
      'document', 'same-text-raw-x', 'shared2', 'shared2-1',
    ]);
    expect(chunks.map((chunk) => chunk.heading)).toEqual([
      '', 'Same text raw x', 'Shared2', 'Shared2',
    ]);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(markdown);
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

  it('preserves headings and UTF-16 ranges in a 300k-character imported document', () => {
    const frontmatter = '---\r\ntitle: Imported source\r\n---\r\n';
    const prose = '한국어 🌙 지식과 업무 흐름. Imported source prose and practical examples.\r\n'.repeat(24);
    let body = '# Document\r\n\r\n';
    for (let index = 0; index < 200; index++) {
      body += `## **Section** &amp; \`code\`\r\n${prose}\r\n`;
    }
    body += '~~~md\r\n## Section & code\r\n~~~~\r\n\r\nSection & code\r\n--------------\r\nLast.';
    const markdown = frontmatter + body;
    expect(markdown.length).toBeGreaterThan(300_000);
    const chunks = chunkNote('raw/import.md', markdown);
    const sectionStarts = chunks.filter((chunk) => chunk.content.startsWith('## **Section**'));
    expect(sectionStarts).toHaveLength(200);
    expect(sectionStarts.map((chunk) => chunk.anchor)).toEqual(
      Array.from({ length: 200 }, (_, index) => `section--code${index ? `-${index}` : ''}`),
    );
    expect(chunks.at(-1)!.anchor).toBe('section--code-200');
    expect(chunks.at(-1)!.heading).toBe('Section & code');
    expect(chunks.at(-1)!.sourceStart).toBe(markdown.lastIndexOf('Section & code\r\n--------------'));
    expect(chunks.at(-1)!.sourceEnd).toBe(markdown.length);
    for (const chunk of chunks) {
      expect(chunk.title).toBe('Imported source');
      expect(markdown.slice(chunk.sourceStart, chunk.sourceEnd)).toBe(chunk.content);
      expect(chunk.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it('discovers many sibling headings without repeated HAST sibling searches', () => {
    const markdown = '# Document\n\n' + '## Repeated\nBody with ~~deleted~~ and [link](https://example.test).\n\n'.repeat(1_000);
    const indexOf = Array.prototype.indexOf;
    let siblingSearches = 0;
    const spy = vi.spyOn(Array.prototype, 'indexOf').mockImplementation(function (this: unknown[], value, fromIndex) {
      if (value && typeof value === 'object' && 'tagName' in value) siblingSearches++;
      return indexOf.call(this, value, fromIndex);
    });
    let chunks: NoteChunk[];
    try {
      chunks = chunkNote('raw/headings.md', markdown);
    } finally {
      spy.mockRestore();
    }
    expect(siblingSearches).toBe(0);
    expect(chunks).toHaveLength(1_001);
    expect(chunks[1]!.anchor).toBe('repeated');
    expect(chunks.at(-1)!.anchor).toBe('repeated-999');
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(markdown);
  });

  it('identifies notes differing only by Unicode compatibility, newline style and trailing whitespace', () => {
    expect(normalizedNoteHash('\n# Ｎｏｔｅ  \r\nBody\t\r\n')).toBe(normalizedNoteHash('# Note\nBody'));
    expect(normalizedNoteHash('# Note\nDifferent body')).not.toBe(normalizedNoteHash('# Note\nBody'));
  });
});
