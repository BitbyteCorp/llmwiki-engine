#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { createContext, type AppContext } from './context.js';
import { registerAuthCommands } from './auth/index.js';
import { registerRagCommands } from './rag/index.js';
import { registerDreamCommands } from './dreaming/index.js';
import { logger } from './log.js';

const program = new Command();
program.name('llmwiki').description('Manage the LLM Wiki engine').version('0.1.0');
let pendingContext: Promise<AppContext> | undefined;
const getCtx = (): Promise<AppContext> => pendingContext ??= createContext(loadConfig());

try {
  registerAuthCommands(program, getCtx);
  registerRagCommands(program, getCtx);
  registerDreamCommands(program, getCtx);
  await program.parseAsync(process.argv);
} catch (error) {
  logger.error({ err: error }, 'llmwiki command failed');
  process.exitCode = 1;
} finally {
  if (pendingContext) {
    const ctx = await pendingContext.catch(() => undefined);
    if (ctx) {
      try { await ctx.jobs.stop(); } finally { ctx.db.close(); }
    }
  }
}
