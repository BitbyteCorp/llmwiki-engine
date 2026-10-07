import type { Command } from 'commander';
import type { AppContext } from '../context.js';

export type { SearchHit } from './types.js';
export { Indexer } from './indexer.js';
export { SearchService } from './search.js';

export function registerRagCommands(program: Command, getCtx: () => Promise<AppContext>): void {
  program.command('reindex')
    .description('Reindex knowledge repository main')
    .option('--full', 'Rebuild the entire derived index')
    .action(async (options: { full?: boolean }) => {
      const ctx = await getCtx();
      if (options.full) await ctx.indexer.rebuild();
      else await ctx.indexer.syncToHead();
      ctx.log.info({ full: Boolean(options.full) }, 'Knowledge index updated');
    });
}
