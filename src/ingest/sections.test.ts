import { describe, expect, it } from 'vitest';
import { DOCUMENT_SECTION_CHARS, splitMarkdownSections } from './sections.js';

function expectSections(
  markdown: string,
  expected: Array<{ title: string; markdown: string }>,
  maxChars = DOCUMENT_SECTION_CHARS,
) {
  const sections = splitMarkdownSections(markdown, maxChars);
  expect(sections).toEqual(expected);
  expect(sections.map((section) => section.markdown).join('')).toBe(markdown);
}

describe('splitMarkdownSections', () => {
  it('returns no sections for empty input', () => {
    expectSections('', []);
  });

  it('uses the exact 40,000-character default budget', () => {
    expect(DOCUMENT_SECTION_CHARS).toBe(40_000);
    const first = `${'x'.repeat(39_999)}\n`;
    const markdown = `${first}tail`;
    const sections = splitMarkdownSections(markdown);
    expect(sections).toEqual([
      { title: 'section', markdown: first },
      { title: 'section', markdown: 'tail' },
    ]);
    expect(sections.map((section) => section.markdown).join('')).toBe(markdown);
  });

  it('greedily merges consecutive whole heading sections up to the exact budget', () => {
    expectSections('# A\none\n# B\ntwo\n# C\nend', [
      { title: 'A', markdown: '# A\none\n# B\ntwo\n' },
      { title: 'C', markdown: '# C\nend' },
    ], 16);
  });

  it('keeps whole sections instead of splitting the next heading to fill a piece', () => {
    expectSections('# A\n1234\n# B\nx\n', [
      { title: 'A', markdown: '# A\n1234\n' },
      { title: 'B', markdown: '# B\nx\n' },
    ], 12);
  });

  it('starts an oversized section at its heading instead of filling the previous piece', () => {
    expectSections('# A\nok\n# B\n1234\n5678\n', [
      { title: 'A', markdown: '# A\nok\n' },
      { title: 'B', markdown: '# B\n1234\n' },
      { title: 'section', markdown: '5678\n' },
    ], 10);
  });

  it('packs a final fragment with a following whole section when it fits', () => {
    expectSections('# A\n1234\n5678\n# B\nx\n', [
      { title: 'A', markdown: '# A\n1234\n' },
      { title: 'B', markdown: '5678\n# B\nx\n' },
    ], 11);
  });

  it('prefers paragraph boundaries over filling a piece with the next paragraph', () => {
    expectSections('# A\nabc\n\ndef\nghi\n\njk\n', [
      { title: 'A', markdown: '# A\nabc\n\n' },
      { title: 'section', markdown: 'def\nghi\n\njk\n' },
    ], 12);
  });

  it('falls back to whole lines only for oversized paragraphs and packs their tails', () => {
    expectSections('ok\n\nabcd\nefgh\nijkl\n\nz', [
      { title: 'section', markdown: 'ok\n\n' },
      { title: 'section', markdown: 'abcd\nefgh\n' },
      { title: 'section', markdown: 'ijkl\n\nz' },
    ], 12);
  });

  it('retains whitespace-only blank-line runs with their preceding paragraph', () => {
    expectSections('# A\nabc\n \t\n\ndef\n\ntail', [
      { title: 'A', markdown: '# A\nabc\n \t\n\n' },
      { title: 'section', markdown: 'def\n\ntail' },
    ], 12);
  });

  it('finds the first heading after a preamble when pieces merge', () => {
    expectSections('intro\n\n# First\nbody\n## Second\nend', [
      { title: 'First', markdown: 'intro\n\n# First\nbody\n## Second\nend' },
    ]);
  });

  it.each([
    ['# Title', 'Title'],
    ['   ######\tTitle ### \t', 'Title'],
    ['## Title###', 'Title###'],
    ['# Title ### not closing', 'Title ### not closing'],
    ['#', 'section'],
    ['###   ###  ', 'section'],
  ])('extracts the ATX title from %j', (markdown, title) => {
    expectSections(markdown, [{ title, markdown }]);
  });

  it.each([
    '####### Too many hashes',
    '#Missing whitespace',
    '    # Indented code',
    '\t# Indented code',
    'Setext title\n============',
  ])('does not treat %j as an ATX heading', (prefix) => {
    const markdown = `${prefix}\n# Actual\nbody`;
    expectSections(markdown, [{ title: 'Actual', markdown }]);
  });

  it('uses the first empty heading rather than a later nonempty heading for the title', () => {
    expectSections('#\n## Later\nbody', [{ title: 'section', markdown: '#\n## Later\nbody' }]);
  });

  it.each([
    ['backticks', '````js\n# Hidden\n```\n# Still hidden\n~~~~\n# Wrong marker\n```` trailing\n# Not closed\n````` \t\n'],
    ['tildes', '  ~~~~ info `allowed`\n# Hidden\n~~~\n# Still hidden\n```\n# Wrong marker\n~~~~ trailing\n# Not closed\n   ~~~~~\t\n'],
  ])('ignores fenced headings with %s, matching the full opener and closer rules', (_name, fenced) => {
    expectSections(`${fenced}# Visible\nbody`, [
      { title: 'section', markdown: fenced },
      { title: 'Visible', markdown: '# Visible\nbody' },
    ], fenced.length);
  });

  it('does not reset fence context when a long fenced block splits across pieces', () => {
    expectSections('```\n# fake\nmore\n```\n# Real\n', [
      { title: 'section', markdown: '```\n' },
      { title: 'section', markdown: '# fake\n' },
      { title: 'section', markdown: 'more\n```\n' },
      { title: 'Real', markdown: '# Real\n' },
    ], 9);
  });

  it('keeps headings inside an unclosed fence hidden through the end of input', () => {
    const markdown = '~~~\n# Hidden\n## Also hidden';
    expectSections(markdown, [{ title: 'section', markdown }]);
  });

  it.each([
    '```bad`info\n',
    '    ```\n',
    '\t~~~\n',
  ])('does not open a fence with %j', (prefix) => {
    const markdown = `${prefix}# Visible\nbody`;
    expectSections(markdown, [{ title: 'Visible', markdown }]);
  });

  it('does not close a fence with four-space indentation', () => {
    const markdown = '```\n    ```\n# Hidden\n```\n# Visible';
    expectSections(markdown, [{ title: 'Visible', markdown }]);
  });

  it('preserves CRLF separators and trailing whitespace without adding a final newline', () => {
    expectSections('# A\r\none\r\n\r\n# B\r\ntwo\r\n\r\n# C\r\nlast  ', [
      { title: 'A', markdown: '# A\r\none\r\n\r\n# B\r\ntwo\r\n\r\n' },
      { title: 'C', markdown: '# C\r\nlast  ' },
    ], 24);
  });

  it('preserves CRLF boundaries during paragraph and line fallback', () => {
    expectSections('a\r\n\r\nbb\r\ncc\r\n\r\nz', [
      { title: 'section', markdown: 'a\r\n\r\n' },
      { title: 'section', markdown: 'bb\r\ncc\r\n' },
      { title: 'section', markdown: '\r\nz' },
    ], 8);
  });

  it('preserves mixed newline styles and whitespace-only input', () => {
    expectSections(' \t\r\n\n  \r', [{ title: 'section', markdown: ' \t\r\n\n  \r' }]);
  });

  it('does not split a surrogate pair adjacent to the character threshold', () => {
    expectSections('a\nb😀\nc\n', [
      { title: 'section', markdown: 'a\n' },
      { title: 'section', markdown: 'b😀\n' },
      { title: 'section', markdown: 'c\n' },
    ], 4);
  });

  it('leaves an unbroken oversized line intact, including its newline', () => {
    const oversized = `${'x'.repeat(100_001)}\n`;
    expectSections(`prefix\n${oversized}after`, [
      { title: 'section', markdown: 'prefix\n' },
      { title: 'section', markdown: oversized },
      { title: 'section', markdown: 'after' },
    ], 8);
  });

  it('leaves an oversized single line without a trailing newline intact', () => {
    const markdown = '😀'.repeat(25_000);
    expectSections(markdown, [{ title: 'section', markdown }]);
  });
});
