import type { INestApplication } from '@nestjs/common';
import express from 'express';

export function configureApp(app: INestApplication, config?: { trustProxy?: boolean }): void {
  app.getHttpAdapter().getInstance().set('trust proxy', config?.trustProxy ?? false);
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
