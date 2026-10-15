import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MEMORY_BUDGET_CHARS, MEMORY_SECTIONS, memoryIssues } from './memory.js';

const seed = readFileSync(new URL('./seed/MEMORY.md', import.meta.url), 'utf8');
const sections = MEMORY_SECTIONS.map((section) => `## ${section}`).join('\n\n');

describe('memory contract', () => {
  it('accepts the seed with empty sections', () => {
    expect(memoryIssues(seed)).toEqual([]);
  });

  it('counts the whole file in Unicode code points rather than UTF-16 code units', () => {
    const prefix = `${sections}\n\n`;
    const atBudget = prefix + '😀'.repeat(MEMORY_BUDGET_CHARS - [...prefix].length);
    expect(memoryIssues(atBudget)).toEqual([]);
    expect(memoryIssues(atBudget + '😀').join('\n')).toContain('4001');
  });

  it('reports missing required sections', () => {
    expect(memoryIssues('## 작업 관례\n\n## 참조\n').join('\n')).toContain('## 진행 중');
  });

  it('reports out-of-order sections', () => {
    expect(memoryIssues('## 진행 중\n\n## 작업 관례\n\n## 참조\n').join('\n')).toContain('이 순서');
  });

  it.each([`${sections}\n\n## 참조\n`, `${sections}\n\n## 추가\n`])('rejects duplicate or additional sections: %s', (content) => {
    expect(memoryIssues(content)).not.toEqual([]);
  });

  it('does not accept required headings inside fenced examples', () => {
    expect(memoryIssues(`\`\`\`markdown\n${sections}\n\`\`\``).join('\n')).toContain('섹션이 필요하다');
  });

  it('accepts CRLF and ignores heading examples inside a section', () => {
    expect(memoryIssues(`${seed}\n~~~markdown\n## 예시\n~~~\n`.replaceAll('\n', '\r\n'))).toEqual([]);
  });
});
