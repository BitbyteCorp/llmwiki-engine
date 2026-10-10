import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { isMetadataTarget, noteMetadataDate, stampNoteMetadata } from './note-metadata.js';

const human = { date: '2026-10-10', requesterName: 'New Requester', botName: '도니' };
const system = { date: '2026-10-10', botName: '도니' };

describe('engine-owned note metadata', () => {
  it('changes only engine value ranges and preserves YAML comments, custom fields, and body bytes', () => {
    const before = `---\n# frontmatter comment\ntype: 'note' # retain quoting\nauthor: ["Existing", 'Other'] # credits\n'date created': 2020-01-01 # original creation\n"date modified": '2020-02-02' # modified comment\naliases: []\ncustom:\n  nested: &values [one, two] # extra metadata\ncopy: *values\ndescription: |\n  Two lines\n  of description.\n---\n\n# Body\n\nLiteral --- and trailing spaces  \n`;
    const after = stampNoteMetadata(before, human);
    expect(after).toBe(before
      .replace(`["Existing", 'Other']`, `["Existing", 'Other', "New Requester"]`)
      .replace(`'2020-02-02'`, '2026-10-10'));
    expect(matter(after).data.author).toEqual(['Existing', 'Other', 'New Requester']);
    expect(stampNoteMetadata(after, human)).toBe(after);
  });

  it('appends human authors to a block list without rewriting existing entries or comments', () => {
    const before = `---\nauthor:\n  - 'Existing' # credit\n  # explanation\n  - "Other" # another credit\n# tags comment\ntags: [knowledge]\ndate created: 2020-01-01\ndate modified: 2026-10-10\n---\nbody\n`;
    expect(stampNoteMetadata(before, human)).toBe(before.replace(
      '  - "Other" # another credit',
      '  - "Other" # another credit\n  - "New Requester"',
    ));
  });

  it('adds missing engine fields to new notes, preserving the complete body and CRLF', () => {
    const body = '# New note\r\n\r\nBody with spaces  \r\n';
    expect(stampNoteMetadata(body, human)).toBe(
      '---\r\nauthor: ["New Requester"]\r\ndate created: 2026-10-10\r\ndate modified: 2026-10-10\r\n---\r\n' + body,
    );
    const partial = '---\r\ntitle: "Keep" # comment\r\n---\r\n' + body;
    const stamped = stampNoteMetadata(partial, human);
    expect(stamped).toBe('---\r\ntitle: "Keep" # comment\r\ndate created: 2026-10-10\r\ndate modified: 2026-10-10\r\nauthor: ["New Requester"]\r\n---\r\n' + body);
    expect(matter(stamped).data).not.toHaveProperty('domain');
  });

  it.each(['', '\n', '# preserved empty-frontmatter comment\n'])('fills empty frontmatter without dropping its whitespace or comments: %j', (yaml) => {
    const before = `---\n${yaml}---\n# Body\n`;
    expect(stampNoteMetadata(before, human)).toBe(`---\n${yaml}date created: 2026-10-10\ndate modified: 2026-10-10\nauthor: ["New Requester"]\n---\n# Body\n`);
  });

  it('fills empty CRLF frontmatter without treating the body as YAML', () => {
    const before = '---\r\n---\r\n# Body\r\n\r\nBody spacing  \r\n';
    expect(stampNoteMetadata(before, human)).toBe('---\r\ndate created: 2026-10-10\r\ndate modified: 2026-10-10\r\nauthor: ["New Requester"]\r\n---\r\n# Body\r\n\r\nBody spacing  \r\n');
  });

  it.each(['author: []', 'author:', ''])('credits the bot only when authors are empty or missing: %s', (author) => {
    const before = `---\n${author}\ndate created: 2020-01-01\ndate modified: 2026-10-10\n---\nbody\n`;
    expect(matter(stampNoteMetadata(before, system)).data.author).toEqual(['도니']);
  });

  it('preserves existing human/bot authors on system writes and avoids duplicate human credit', () => {
    const before = '---\nauthor: ["Existing", "도니"]\ndate created: 2020-01-01\ndate modified: 2026-10-10\n---\nbody\n';
    expect(stampNoteMetadata(before, system)).toBe(before);
    expect(stampNoteMetadata(before, { ...human, requesterName: 'Existing' })).toBe(before);
    expect(stampNoteMetadata(before, { ...human, requesterName: 'Name: "quoted"\nnext' })).toContain('"Name: \\"quoted\\"\\nnext"');
  });

  it('normalizes legacy scalar authors without losing credit and replaces other invalid author types', () => {
    const before = '---\nauthor: legacy-author # retained credit\ndate created: 2020-01-01\ndate modified: 2026-10-10\n---\nbody\n';
    expect(stampNoteMetadata(before, human)).toBe(before.replace('author: legacy-author', 'author: ["legacy-author","New Requester"]'));
    expect(stampNoteMetadata(before, system)).toBe(before.replace('author: legacy-author', 'author: ["legacy-author"]'));
    for (const invalid of ['42', '{}', '[42]', '""']) {
      const note = `---\nauthor: ${invalid}\ndate created: 2020-01-01\ndate modified: 2026-10-10\n---\nbody\n`;
      expect(matter(stampNoteMetadata(note, human)).data.author).toEqual(['New Requester']);
      expect(matter(stampNoteMetadata(note, system)).data.author).toEqual(['도니']);
    }
  });

  it('preserves engine-field anchors and aliases when changing their values', () => {
    const before = '---\nauthor: &credits ["Existing"]\ncustom authors: *credits\ndate created: 2020-01-01\ndate modified: &modified 2020-02-02\ncustom date: *modified\n---\nbody\n';
    const after = stampNoteMetadata(before, human);
    expect(after).toBe(before
      .replace('["Existing"]', '["Existing", "New Requester"]')
      .replace('2020-02-02', '2026-10-10'));
    expect(matter(after).data['custom authors']).toEqual(['Existing', 'New Requester']);
    expect(matter(after).data['custom date'].toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it.each([
    '---\nauthor: [broken\ncustom: retain me\n---\nbody\n',
    '---\nauthor: ["Existing"]\nbody without closing delimiter\n',
    '---\n- not a mapping\n---\nbody\n',
    '---\nauthor: []\nauthor: ["duplicate"]\n---\nbody\n',
  ])('leaves malformed frontmatter intact without throwing', (before) => {
    expect(stampNoteMetadata(before, human)).toBe(before);
  });

  it('supports flow mappings and merged custom metadata without expanding them', () => {
    const flow = '---\n{custom: "keep", author: ["Existing"], date created: 2020-01-01, date modified: 2020-02-02}\n---\nbody\n';
    expect(stampNoteMetadata(flow, human)).toBe(flow
      .replace('["Existing"]', '["Existing", "New Requester"]')
      .replace('2020-02-02', '2026-10-10'));
    const inherited = '---\ncustom: &metadata {author: ["Existing"], date created: 2020-01-01, date modified: 2020-02-02}\n<<: *metadata\n---\nbody\n';
    const after = stampNoteMetadata(inherited, human);
    expect(after).toContain('custom: &metadata {author: ["Existing"], date created: 2020-01-01, date modified: 2020-02-02}\n<<: *metadata\n');
    expect(matter(after).data.author).toEqual(['Existing', 'New Requester']);
    expect(matter(after).data['date created'].toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it.each(['{}', '{custom: "keep"}', '{custom: "keep",}'])('inserts missing fields inside a flow mapping: %s', (yaml) => {
    const before = `---\n${yaml}\n---\nbody\n`;
    const after = stampNoteMetadata(before, human);
    const expected = yaml === '{}'
      ? '{date created: 2026-10-10, date modified: 2026-10-10, author: ["New Requester"]}'
      : yaml.replace('"keep"', '"keep", date created: 2026-10-10, date modified: 2026-10-10, author: ["New Requester"]');
    expect(after).toBe(`---\n${expected}\n---\nbody\n`);
    expect(matter(after).data.author).toEqual(['New Requester']);
  });

  it('appends to multiline flow sequences while retaining trailing commas and comments', () => {
    const before = '---\nauthor: [\n  "Existing", # first credit\n  "Other", # second credit\n]\ndate created: 2020-01-01\ndate modified: 2026-10-10\n---\nbody\n';
    const after = stampNoteMetadata(before, human);
    expect(after).toBe(before.replace('  "Other", # second credit', '  "Other", "New Requester", # second credit'));
    expect(matter(after).data.author).toEqual(['Existing', 'Other', 'New Requester']);
  });

  it('uses the journal calendar at UTC boundaries and supports explicit timezone fixtures', () => {
    const now = new Date('2026-10-09T15:30:00.000Z');
    expect(noteMetadataDate(now)).toBe('2026-10-10');
    expect(noteMetadataDate(now, 'UTC')).toBe('2026-10-09');
    expect(noteMetadataDate(new Date('2026-10-10T00:30:00.000Z'), 'America/Los_Angeles')).toBe('2026-10-09');
  });

  it('targets only wiki markdown notes except AGENTS.md, including hubs and deeper folders', () => {
    for (const path of ['wiki/note.md', 'wiki/domain/index.md', 'wiki/deep/folder/note.MD']) expect(isMetadataTarget(path)).toBe(true);
    for (const path of ['AGENTS.md', 'wiki/domain/AGENTS.md', 'wiki/deep/AGENTS.md', 'MEMORY.md', 'index.md', 'journal/2026-10-10.md', 'raw/note.md', 'assets/note.md', 'wiki/image.png']) expect(isMetadataTarget(path)).toBe(false);
  });
});
