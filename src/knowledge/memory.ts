export const MEMORY_PATH = 'MEMORY.md';
export const MEMORY_BUDGET_CHARS = 4000;
export const MEMORY_SECTIONS = ['작업 관례', '진행 중', '참조'] as const;

export function memoryIssues(content: string): string[] {
  const issues: string[] = [];
  let chars = 0;
  for (const _char of content) chars++;
  if (chars > MEMORY_BUDGET_CHARS) {
    issues.push(`MEMORY.md는 파일 전체 ${MEMORY_BUDGET_CHARS}자(유니코드 코드 포인트) 이하여야 한다. 현재 ${chars}자다.`);
  }

  const sections: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) {
      fence = { marker: marker[1][0], length: marker[1].length };
      continue;
    }
    const heading = /^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(line);
    if (heading) sections.push(heading[1]);
  }
  for (const section of MEMORY_SECTIONS) {
    if (!sections.includes(section)) issues.push(`MEMORY.md에 '## ${section}' 섹션이 필요하다.`);
  }
  if (sections.length !== MEMORY_SECTIONS.length || sections.some((section, index) => section !== MEMORY_SECTIONS[index])) {
    issues.push(`MEMORY.md의 2단계 섹션은 ${MEMORY_SECTIONS.map((section) => `'## ${section}'`).join(', ')}만 이 순서로 한 번씩 둔다.`);
  }
  return issues;
}
