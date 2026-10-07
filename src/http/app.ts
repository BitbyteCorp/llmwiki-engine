import express, { type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { AppContext } from '../context.js';
import { authRouter } from '../auth/index.js';
import { mcpRouter } from '../mcp/index.js';
import { apiRouter } from '../api/index.js';

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(cookieParser(ctx.config.sessionSecret));
  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });
  app.use(authRouter(ctx));
  app.use('/mcp', mcpRouter(ctx));
  app.use('/api', apiRouter(ctx));

  const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get('/{*path}', (req, res, next) => {
      if (/^\/(api|auth|oauth|mcp|\.well-known)(\/|$)/.test(req.path)) { next(); return; }
      res.sendFile(join(webDist, 'index.html'));
    });
  }
  app.use((_req, res) => { res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }); });
  const errors: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) { next(error); return; }
    const statusValue = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    const status = typeof statusValue === 'number' && statusValue >= 400 && statusValue <= 599 ? statusValue : 500;
    const codeValue = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const code = typeof codeValue === 'string' ? codeValue : status === 500 ? 'internal_error' : 'bad_request';
    const message = status === 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed';
    if (status >= 500) ctx.log.error({ err: error, path: req.path }, 'HTTP request failed');
    res.status(status).json({ error: { code, message } });
  };
  app.use(errors);
  return app;
}
