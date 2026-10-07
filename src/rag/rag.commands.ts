import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import type { Logger } from 'pino';
import { LOGGER } from '../common/tokens.js';
import { IndexerService } from './indexer.service.js';

export function registerRagCommands(
  program: Command,
  getApp: () => Promise<INestApplicationContext>,
): void {
  program.command('reindex')
    .description('Reindex knowledge repository main')
    .option('--full', 'Rebuild the entire derived index')
    .action(async (options: { full?: boolean }) => {
      const app = await getApp();
      const indexer = app.get(IndexerService);
      if (options.full) await indexer.rebuild();
      else await indexer.syncToHead();
      app.get<Logger>(LOGGER).info({ full: Boolean(options.full) }, 'Knowledge index updated');
    });
}
