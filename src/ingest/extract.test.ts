import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractDocument, extractVault } from './extract.js';

/** A real generated single-page PDF, including cross-reference byte offsets. */
export function generatedPdf(): Buffer {
  const text = 'BT /F1 12 Tf 72 700 Td (Generated PDF knowledge) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe('source extraction', () => {
  it('extracts a readable HTML article, not navigation or scripts, with absolute links', async () => {
    const html = `<html><head><title>Knowledge Article</title></head><body><nav>unrelated menu</nav><article><h1>Knowledge Article</h1><p>${'This is a substantive paragraph explaining knowledge integration and original provenance. '.repeat(15)}<a href="/reference">Reference</a></p><script>window.secret = 'never include this';</script></article></body></html>`;
    const result = await extractDocument(Buffer.from(html), 'text/html', 'article.html', 'https://example.com/page');
    expect(result.title).toBe('Knowledge Article');
    expect(result.markdown).toContain('explaining knowledge integration');
    expect(result.markdown).toContain('[Reference](https://example.com/reference)');
    expect(result.markdown).not.toContain('window.secret');
    expect(result.markdown).not.toContain('unrelated menu');
  });
  it('extracts text from a generated PDF document', async () => {
    const result = await extractDocument(generatedPdf(), 'application/pdf', 'fixture.pdf');
    expect(result.markdown).toBe('Generated PDF knowledge');
  });
  it('reports a malformed PDF as a source error', async () => {
    await expect(extractDocument(Buffer.from('%PDF-1.4\nbroken'), 'application/pdf', 'broken.pdf')).rejects.toMatchObject({ status: 400, code: 'invalid_source' });
  });
  it('retains Obsidian Markdown wikilinks and binary attachments', () => {
    const result = extractVault(Buffer.from(zipSync({
      'notes/First.md': strToU8('# First\n[[Second]]\n![[image.png]]'),
      'notes/Second.md': strToU8('# Second\nUseful knowledge'),
      'notes/image.png': new Uint8Array([137, 80, 78, 71, 0, 255]),
      '.obsidian/workspace.json': strToU8('{}'),
    })), 'obsidian');
    expect(result.files.map((file) => file.path)).toEqual(['notes/First.md', 'notes/image.png', 'notes/Second.md']);
    expect(result.files.find((file) => file.path === 'notes/First.md')!.buffer.toString()).toContain('[[Second]]');
    expect(result.files.find((file) => file.path === 'notes/image.png')!.buffer).toEqual(Buffer.from([137, 80, 78, 71, 0, 255]));
  });
  it('normalizes Notion IDs consistently in nested filenames, Markdown links and attachments', () => {
    const id = '0123456789abcdef0123456789abcdef';
    const result = extractVault(Buffer.from(zipSync({
      [`Folder ${id}/Home ${id}.md`]: strToU8(`[Child](Child%20${id}.md)\n![image](picture%20${id}.png)\n[[Child ${id}|Alias]]\nID in prose ${id}`),
      [`Folder ${id}/Child ${id}.md`]: strToU8('# Child'),
      [`Folder ${id}/picture ${id}.png`]: new Uint8Array([1, 2, 3]),
    })), 'notion');
    expect(result.files.map((file) => file.path)).toEqual(['Folder/Child.md', 'Folder/Home.md', 'Folder/picture.png']);
    expect(result.files.find((file) => file.path === 'Folder/Home.md')!.buffer.toString()).toBe(`[Child](Child.md)\n![image](picture.png)\n[[Child|Alias]]\nID in prose ${id}`);
  });
  it('normalizes reference links while retaining encoded parentheses and heading fragments', () => {
    const id = '0123456789abcdef0123456789abcdef';
    const result = extractVault(Buffer.from(zipSync({
      [`Home ${id}.md`]: strToU8(`[page][ref]\n[ref]: <Child%20%28draft%29%20${id}.md#heading> "Title"\n[external](https://example.com/Child%20${id}.md)`),
      [`Child (draft) ${id}.md`]: strToU8('# Heading'),
    })), 'notion');
    expect(result.files.find((file) => file.path === 'Home.md')!.buffer.toString()).toBe(`[page][ref]\n[ref]: <Child%20%28draft%29.md#heading> "Title"\n[external](https://example.com/Child%20${id}.md)`);
  });
  it.each(['../escape.md', '/absolute.md', 'folder/../../escape.md', 'folder\\escape.md', '.git/config'])('rejects unsafe ZIP path %s', (path) => {
    expect(() => extractVault(Buffer.from(zipSync({ [path]: strToU8('danger') })), 'obsidian')).toThrow('Unsafe ZIP');
  });
  it('rejects a compressed ZIP bomb before extracting it', () => {
    const archive = Buffer.from(zipSync({ 'huge.md': new Uint8Array(21 * 1024 * 1024) }));
    expect(() => extractVault(archive, 'obsidian')).toThrow('expanded size');
  });
  it('rejects Notion canonical-name collisions instead of losing notes', () => {
    const archive = Buffer.from(zipSync({ 'A 0123456789abcdef0123456789abcdef.md': strToU8('one'), 'A fedcba9876543210fedcba9876543210.md': strToU8('two') }));
    expect(() => extractVault(archive, 'notion')).toThrow('collide');
  });
  it('rejects ZIP symlinks', () => {
    const archive = Buffer.from(zipSync({ 'note.md': strToU8('# Note') }));
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(0xa1ff0000, central + 38);
    expect(() => extractVault(archive, 'obsidian')).toThrow('symlink');
  });
});
