import type { INestApplication } from '@nestjs/common';
import express from 'express';

export function configureApp(app: INestApplication): void {
  app.use(
    '/oauth',
    express.urlencoded({ extended: false, limit: '64kb' }),
    express.json({ limit: '64kb' }),
  );
  // Nest deduplicates parsers by function name, including path-scoped middleware.
  // Register the normal backend defaults explicitly after the stricter OAuth parsers.
  app.use(express.json(), express.urlencoded({ extended: true }));
}
