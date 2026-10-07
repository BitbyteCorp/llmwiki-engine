import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { join } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { logger } from '../log.js';
import { HealthController } from './health.controller.js';
import { CONFIG, DB, LOGGER } from './tokens.js';

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: LOGGER, useValue: logger },
    {
      provide: DB,
      inject: [CONFIG],
      useFactory: (config: Config): Db => {
        const db = openDb(join(config.dataDir, 'llmwiki.db'));
        try {
          runMigrations(db);
          return db;
        } catch (error) {
          db.close();
          throw error;
        }
      },
    },
  ],
  exports: [CONFIG, DB, LOGGER],
})
export class CommonModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  onApplicationShutdown(): void {
    // Nest shuts global modules down last, after domain providers have stopped.
    if (this.db.open) this.db.close();
  }
}
