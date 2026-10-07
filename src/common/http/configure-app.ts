import type { INestApplication } from '@nestjs/common';
import express from 'express';
import compression from 'compression';
import { constants } from 'node:zlib';

export function configureApp(app: INestApplication, config?: { trustProxy?: boolean }): void {
  app.getHttpAdapter().getInstance().set('trust proxy', config?.trustProxy ?? false);
  app.use(compression({
    threshold: 1024,
    level: constants.Z_BEST_SPEED,
    filter: (request, response) => {
      // Never buffer any SSE endpoint, even before it sets its response type.
      if (request.path === '/api/events' || /^\/api\/generations\/[^/]+\/events$/.test(request.path)) return false;
      return /^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(String(response.getHeader('Content-Type') ?? ''))
        && compression.filter(request, response);
    },
  }));
  app.use(
    '/oauth',
    express.urlencoded({ extended: false, limit: '64kb' }),
    express.json({ limit: '64kb' }),
  );
  // Text ingestion accepts 20 MiB decoded source plus a JSON metadata envelope.
  app.use(['/api/imports', '/mcp'], express.json({ limit: '21mb' }));
  // Nest deduplicates parsers by function name, including path-scoped middleware.
  // Register normal backend defaults explicitly after the route-scoped parsers.
  app.use(express.json(), express.urlencoded({ extended: true }));
}
