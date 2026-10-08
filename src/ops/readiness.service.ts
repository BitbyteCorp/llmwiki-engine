import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { IndexerService } from '../rag/indexer.service.js';

export type InitialIndexState = 'pending' | 'ready' | 'skipped' | 'error';
export interface ReadinessStatus {
  ok: boolean;
  initialIndex: InitialIndexState;
  checks: { database: boolean; repository: boolean; index: boolean };
}

@Injectable()
export class ReadinessService {
  initialIndex: InitialIndexState = 'pending';

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: KnowledgeRepo,
    private readonly indexer: IndexerService,
  ) {}

  markInitialIndexReady(): void { this.initialIndex = 'ready'; }
  markInitialIndexError(): void { this.initialIndex = 'error'; }
  markInitialIndexSkipped(): void { this.initialIndex = 'skipped'; }

  async check(): Promise<ReadinessStatus> {
    const checks = { database: false, repository: false, index: false };
    try { checks.database = Boolean(this.db.prepare('SELECT 1').get()); } catch { /* Probe failure is not liveness failure. */ }
    try { checks.repository = Boolean((await this.repo.headSha()).trim()); } catch { /* Unusable repository. */ }
    try { checks.index = (await this.indexer.status()).lastError === null; } catch { /* Unavailable index status. */ }
    const initialIndex = this.initialIndex;
    const initialIndexComplete = initialIndex === 'ready' || initialIndex === 'skipped';
    return { ok: initialIndexComplete && checks.database && checks.repository && checks.index, initialIndex, checks };
  }
}
