import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type * as NextExports from 'next/dist/server/next.js';
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
import { resolve } from 'node:path';
import { AppModule } from './app.module.js';
import type { Config } from './config.js';
import { CONFIG, LOGGER } from './common/tokens.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { configureApp } from './common/http/configure-app.js';
import { IndexerService } from './rag/indexer.service.js';
import { WriteJobsService } from './jobs/write-jobs.service.js';
import { DreamingService } from './dreaming/dreaming.service.js';
import { logger, type Logger } from './log.js';

// Next's CommonJS entry exposes a callable export, unlike its NodeNext declaration.
const next = createRequire(import.meta.url)('next') as typeof NextExports.default.default;

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, new ExpressAdapter(), { bodyParser: true });
  const config = app.get<Config>(CONFIG);
  const log = app.get<Logger>(LOGGER);
  const web = next({ dev: config.nodeEnv !== 'production', dir: resolve('web') });
  const lifecycle = app.get(AppModule);
  lifecycle.closeNext = () => web.close();
  try {
    await web.prepare();
    const handleNext = web.getRequestHandler();
    const express = app.getHttpAdapter().getInstance();
    express.disable('x-powered-by');
    app.use(cookieParser(config.sessionSecret));
    configureApp(app);
    app.use((req: Request, res: Response, nextRoute: NextFunction) => {
      if (/^\/(api|auth|oauth|mcp|\.well-known|healthz)(\/|$)/.test(req.path)) {
        nextRoute();
        return;
      }
      void handleNext(req, res).catch(nextRoute);
    });
    app.useGlobalFilters(new HttpExceptionFilter(log));
    app.enableShutdownHooks();
    await app.init();
    lifecycle.initialIndex = app.get(IndexerService).syncToHead().catch((error: unknown) => {
      log.error({ err: error }, 'Initial knowledge indexing failed');
    });
    app.get(WriteJobsService).start();
    app.get(DreamingService).start();
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
