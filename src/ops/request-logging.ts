import { newId } from '../common/ids.js';
import type { RequestHandler } from 'express';
import { SessionsService } from '../auth/sessions.service.js';
import type { Logger } from '../log.js';
import { MetricsService } from './metrics.service.js';

/** Never label a request with its raw URL, query, note path, or resource ID. */
export function requestLogging(log: Logger, metrics: MetricsService, sessions: SessionsService): RequestHandler {
  return (request, response, next) => {
    const incoming = request.get('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : newId();
    request.headers['x-request-id'] = requestId;
    response.setHeader('X-Request-ID', requestId);
    const started = performance.now();
    const sessionUserId = sessions.sessionUser(request)?.id ?? null;
    response.once('finish', () => {
      const registeredRoute: unknown = request.route?.path;
      const route = typeof registeredRoute === 'string' ? registeredRoute
        : /^\/(api|auth|oauth|mcp|\.well-known|healthz|readyz|metrics)(\/|$)/.test(request.path) ? 'unmatched_backend'
        : request.path.startsWith('/_next/') ? 'next_asset' : 'next_page';
      const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)$/.test(request.method) ? request.method : 'OTHER';
      const ms = performance.now() - started;
      log.info({ method, route, status: response.statusCode, ms, requestId, userId: request.user?.id ?? sessionUserId }, 'HTTP request finished');
      metrics.observeRequest(method, route, response.statusCode, ms / 1000);
    });
    next();
  };
}
