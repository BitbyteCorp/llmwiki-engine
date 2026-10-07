import { join } from 'node:path';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { openDb, runMigrations, type Db } from './db/index.js';
import { logger } from './log.js';
import { KnowledgeRepo } from './knowledge/repo.js';
import { Indexer, SearchService } from './rag/index.js';
import { Luna } from './luna/index.js';
import { WriteJobService } from './jobs/service.js';
import { UserService } from './auth/index.js';

export interface AppContext {
  config: Config; db: Db; log: Logger;
  repo: KnowledgeRepo; indexer: Indexer; search: SearchService;
  luna: Luna; jobs: WriteJobService; users: UserService;
}

export async function createContext(config: Config): Promise<AppContext> {
  const db = openDb(join(config.dataDir, 'llmwiki.db'));
  try {
    runMigrations(db);
    const log = logger;
    const repo = await KnowledgeRepo.open(config, log);
    const indexer = new Indexer({ config, db, log, repo });
    indexer.init();
    const search = new SearchService({ config, db, log });
    const luna = new Luna({ config, log, repo, search });
    const users = new UserService(db);
    // Jobs are the only cyclic dependency; attach before exposing the context.
    const ctx = { config, db, log, repo, indexer, search, luna, users } as AppContext;
    ctx.jobs = new WriteJobService(ctx);
    return ctx;
  } catch (error) {
    db.close();
    throw error;
  }
}
