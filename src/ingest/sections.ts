export const DOCUMENT_SECTION_CHARS = 40_000;

type MarkdownLine = {
  start: number;
  end: number;
  blank: boolean;
  title?: string;
};

export function splitMarkdownSections(
  markdown: string,
  maxChars = DOCUMENT_SECTION_CHARS,
): Array<{ title: string; markdown: string }> {
  const lines: MarkdownLine[] = [];
  const sections = [0];
  let fence: { character: string; length: number } | undefined;
  const linePattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(markdown)) && match[0].length) {
    const text = match[0].replace(/(?:\r\n|\r|\n)$/, '');
    const line: MarkdownLine = {
      start: match.index,
      end: linePattern.lastIndex,
      blank: /^[ \t]*$/.test(text),
    };
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence.character
        && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      }
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { character: marker[1][0], length: marker[1].length };
    } else {
      const heading = /^ {0,3}#{1,6}(?=\s|$)(.*)$/.exec(text);
      if (heading) {
        line.title = heading[1].replace(/\s+#+\s*$/, '').trim() || 'section';
        if (lines.length) sections.push(lines.length);
      }
    }
    lines.push(line);
  }
  sections.push(lines.length);

  const result: Array<{ title: string; markdown: string }> = [];
  let pieceStart = -1;
  let pieceEnd = 0;
  const length = (start: number, end: number) => lines[end - 1].end - lines[start].start;
  const flush = () => {
    if (pieceStart < 0) return;
    let title = 'section';
    for (let index = pieceStart; index < pieceEnd; index++) {
      if (lines[index].title !== undefined) {
        title = lines[index].title!;
        break;
      }
    }
    result.push({
      title,
      markdown: markdown.slice(lines[pieceStart].start, lines[pieceEnd - 1].end),
    });
    pieceStart = -1;
  };
  const append = (start: number, end: number) => {
    if (pieceStart >= 0 && length(pieceStart, end) > maxChars) flush();
    if (pieceStart < 0) pieceStart = start;
    pieceEnd = end;
  };

  for (let section = 0; section < sections.length - 1; section++) {
    const start = sections[section];
    const end = sections[section + 1];
    if (start === end) continue;
    if (length(start, end) <= maxChars) {
      append(start, end);
      continue;
    }

    // Keep a new heading intact rather than filling the previous piece with its prefix.
    flush();
    let paragraphStart = start;
    for (let paragraphEnd = start + 1; paragraphEnd <= end; paragraphEnd++) {
      // Blank-line runs belong to the preceding paragraph, preserving every separator.
      if (paragraphEnd < end
        && (!lines[paragraphEnd - 1].blank || lines[paragraphEnd].blank)) continue;
      if (length(paragraphStart, paragraphEnd) <= maxChars) {
        append(paragraphStart, paragraphEnd);
      } else {
        // Prefer the paragraph boundary even when the previous piece has room left.
        flush();
        for (let line = paragraphStart; line < paragraphEnd; line++) append(line, line + 1);
      }
      paragraphStart = paragraphEnd;
    }
  }
  flush();
  return result;
}
