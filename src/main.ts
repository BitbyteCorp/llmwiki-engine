import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type * as NextExports from 'next/dist/server/next.js';
import { createRequire } from 'node:module';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import type { Request, Response, NextFunction } from 'express';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module.js';
import type { Config } from './config.js';
import { CONFIG, LOGGER } from './common/tokens.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { configureApp } from './common/http/configure-app.js';
import { IndexerService } from './rag/indexer.service.js';
import { WriteJobsService } from './jobs/write-jobs.service.js';
import { DreamingService } from './dreaming/dreaming.service.js';
import { logger, type Logger } from './log.js';
import { SessionsService } from './auth/sessions.service.js';
import { MetricsService } from './ops/metrics.service.js';
import { ReadinessService } from './ops/readiness.service.js';
import { requestLogging } from './ops/request-logging.js';

// Next's CommonJS entry exposes a callable export, unlike its NodeNext declaration.
const next = createRequire(import.meta.url)('next') as typeof NextExports.default.default;

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, new ExpressAdapter(), { bodyParser: true });
  const config = app.get<Config>(CONFIG);
  const log = app.get<Logger>(LOGGER);
  const web = next({
    dev: config.nodeEnv !== 'production',
    dir: resolve('web'),
    hostname: new URL(config.publicUrl).hostname,
    port: config.port,
  });
  const lifecycle = app.get(AppModule);
  const pidPath = join(config.dataDir, 'server.pid');
  const ownPid = String(process.pid);
  lifecycle.closeNext = async () => {
    try { await web.close(); } finally {
      try {
        if ((await readFile(pidPath, 'utf8')).trim() === ownPid) await unlink(pidPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.error({ err: error }, 'Failed to remove server PID file');
      }
    }
  };
  app.enableShutdownHooks();
  try {
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(pidPath, `${ownPid}\n`, { mode: 0o600 });
    await web.prepare();
    const handleNext = web.getRequestHandler();
    const express = app.getHttpAdapter().getInstance();
    express.disable('x-powered-by');
    app.use(requestLogging(log, app.get(MetricsService), app.get(SessionsService)));
    app.use(cookieParser(config.sessionSecret));
    configureApp(app, config);
    app.use((req: Request, res: Response, nextRoute: NextFunction) => {
      if (/^\/(api|auth|oauth|mcp|\.well-known|healthz|readyz|metrics)(\/|$)/.test(req.path)) {
        nextRoute();
        return;
      }
      void handleNext(req, res).catch(nextRoute);
    });
    app.useGlobalFilters(new HttpExceptionFilter(log));
    await app.init();
    app.get(DreamingService).recoverInterrupted();
    const readiness = app.get(ReadinessService);
    if (config.jobsAutostart === false) {
      readiness.markInitialIndexSkipped();
    } else {
      lifecycle.initialIndex = app.get(IndexerService).syncToHead().then(() => {
        readiness.markInitialIndexReady();
      }, (error: unknown) => {
        readiness.markInitialIndexError();
        log.error({ err: error }, 'Initial knowledge indexing failed; readiness remains unavailable');
      });
      app.get(WriteJobsService).start();
      app.get(DreamingService).start();
    }
    await app.listen(config.port);
    log.info({ port: config.port }, 'llmwiki-engine listening');
  } catch (error) {
    await app.close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  logger.error({ err: error }, 'llmwiki-engine failed to start');
  process.exitCode = 1;
});
