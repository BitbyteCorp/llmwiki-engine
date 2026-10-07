import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createApp } from './http/app.js';
import { Dreaming } from './dreaming/index.js';
import { logger } from './log.js';

async function main(): Promise<void> {
  const ctx = await createContext(loadConfig());
  let dreaming: Dreaming;
  try { dreaming = new Dreaming(ctx); } catch (error) { ctx.db.close(); throw error; }
  const initialIndex = ctx.indexer.syncToHead().catch((error: unknown) => {
    ctx.log.error({ err: error }, 'Initial knowledge indexing failed');
  });
  let server: Server | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => stopping ??= (async () => {
    const stoppedDreaming = Promise.resolve().then(() => dreaming.stop());
    const stoppedJobs = Promise.resolve().then(() => ctx.jobs.stop());
    const closed = new Promise<void>((resolve, reject) => {
      if (!server?.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
    const results = await Promise.allSettled([closed, stoppedDreaming, stoppedJobs, initialIndex]);
    ctx.db.close();
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason as unknown);
    if (failures.length) throw new AggregateError(failures, 'Shutdown failed');
  })();
  try {
    ctx.jobs.start();
    dreaming.start();
    server = createApp(ctx).listen(ctx.config.port);
    server.once('error', (error) => {
      logger.error({ err: error }, 'HTTP server failed');
      process.exitCode = 1;
      void shutdown().catch((shutdownError: unknown) => logger.error({ err: shutdownError }, 'Shutdown failed'));
    });
    server.once('listening', () => { ctx.log.info({ port: ctx.config.port }, 'llmwiki-engine listening'); });
  } catch (error) {
    await shutdown();
    throw error;
  }
  process.once('SIGTERM', () => { void shutdown().catch((error: unknown) => { logger.error({ err: error }, 'Shutdown failed'); process.exitCode = 1; }); });
  process.once('SIGINT', () => { void shutdown().catch((error: unknown) => { logger.error({ err: error }, 'Shutdown failed'); process.exitCode = 1; }); });
}

void main().catch((error: unknown) => {
  logger.error({ err: error }, 'llmwiki-engine failed to start');
  process.exitCode = 1;
});
