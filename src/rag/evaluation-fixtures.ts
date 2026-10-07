export interface EvaluationNote {
  path: string;
  markdown: string;
}

export interface EvaluationQuery {
  query: string;
  relevantPaths: readonly string[];
}

/** Hand-curated relevance labels, independent of the ranking implementation. */
export const evaluationNotes: readonly EvaluationNote[] = [
  {
    path: 'wiki/storage/backup.md',
    markdown: '---\ntitle: 저장소 백업\ntags: [Storage, "#백업"]\n---\n# 저장소 백업\nGit bundle 백업은 지식 저장소의 전체 커밋 이력을 보존한다. 복원은 체크섬을 검증한 뒤 진행한다.\n## 복원 절차\n백업 파일을 검증하고 저장소를 복원한다.',
  },
  {
    path: 'wiki/storage/retention.md',
    markdown: '---\ntitle: 보존 정책\ntags: [storage]\n---\n# 보존 정책\n저장소 백업은 일별로 보존하고 오래된 사본은 매월 정리한다.',
  },
  {
    path: 'wiki/security/access.md',
    markdown: '---\ntitle: 접근 권한\ntags: [Security]\n---\n# 접근 권한\n읽기 권한은 viewer 역할에 부여된다. 편집 권한은 editor 역할에 부여된다. 관리자만 계정을 승인한다.',
  },
  {
    path: 'wiki/search/hybrid.md',
    markdown: '---\ntitle: 하이브리드 검색\ntags: [검색, Retrieval]\n---\n# 하이브리드 검색\n키워드 검색과 벡터 검색을 결합한다. 한국어 부분 문자열과 영어 단어를 함께 지원한다.',
  },
  {
    path: 'wiki/english/durable.md',
    markdown: '---\ntitle: Durable storage\ntags: [Storage]\n---\n# Durable storage\nDurable storage preserves committed knowledge after a power failure. Atomic rename prevents partially written files.',
  },
  {
    path: 'wiki/english/rotation.md',
    markdown: '---\ntitle: Credential rotation\ntags: [security]\n---\n# Credential rotation\nRotate access credentials by issuing a new token, switching clients, and revoking the old token.',
  },
  {
    path: 'wiki/english/transactions.md',
    markdown: '---\ntitle: Transaction isolation\ntags: [database]\n---\n# Transaction isolation\nA database transaction provides isolation between concurrent writers. Readers observe only committed state.',
  },
  {
    path: 'journal/gardening.md',
    markdown: '# 정원 일기\n꽃과 나무를 심었다. 햇빛과 물을 충분히 주었다. Gardening is unrelated to database operations.',
  },
  {
    path: 'raw/repeated-advertisement.md',
    markdown: '# Vendor advertisement\n' + Array.from({ length: 32 }, (_, index) =>
      `\n## Advertisement ${index + 1}\n${'The slogan durable storage is repeated here without explaining persistence, recovery, or correctness. Buy decorative garden furniture. '.repeat(12)}`,
    ).join('\n'),
  },
];

export const evaluationQueries: readonly EvaluationQuery[] = [
  { query: '저장소 백업', relevantPaths: ['wiki/storage/backup.md', 'wiki/storage/retention.md'] },
  { query: '복원 절차', relevantPaths: ['wiki/storage/backup.md'] },
  { query: '접근 권한', relevantPaths: ['wiki/security/access.md'] },
  { query: '하이브리드 검색', relevantPaths: ['wiki/search/hybrid.md'] },
  { query: 'durable storage', relevantPaths: ['wiki/english/durable.md'] },
  { query: 'credential rotation', relevantPaths: ['wiki/english/rotation.md'] },
  { query: 'transaction isolation', relevantPaths: ['wiki/english/transactions.md'] },
  { query: '키워드 벡터', relevantPaths: ['wiki/search/hybrid.md'] },
];

export interface RetrievalMetrics {
  recallAt3: number;
  mrr: number;
}

/** Macro-average recall; reciprocal rank uses the first relevant result. */
export function retrievalMetrics(
  results: readonly { relevantPaths: readonly string[]; retrievedPaths: readonly string[] }[],
): RetrievalMetrics {
  let recall = 0;
  let reciprocalRank = 0;
  for (const { relevantPaths, retrievedPaths } of results) {
    const relevant = new Set(relevantPaths);
    recall += new Set(retrievedPaths.slice(0, 3).filter((path) => relevant.has(path))).size / relevant.size;
    const first = retrievedPaths.findIndex((path) => relevant.has(path));
    if (first !== -1) reciprocalRank += 1 / (first + 1);
  }
  return { recallAt3: recall / results.length, mrr: reciprocalRank / results.length };
}
