import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

const COOKIE = 'llmwiki_oidc';
const TTL = 30 * 24 * 60 * 60 * 1000;
export const opaquePattern = /^[A-Za-z0-9_-]{43}$/;

export function authBrowser(req: Request): string | undefined {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== COOKIE) continue;
    try {
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      return opaquePattern.test(value) ? value : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

export function ensureAuthBrowser(req: Request, res: Response, publicUrl: string): string {
  const existing = authBrowser(req);
  if (existing) return existing;
  const browser = randomBytes(32).toString('base64url');
  res.cookie(COOKIE, browser, {
    httpOnly: true, sameSite: 'lax', secure: new URL(publicUrl).protocol === 'https:', path: '/', maxAge: TTL,
  });
  return browser;
}

export function localLoginPath(value: unknown, fallback = '/wiki'): string {
  return typeof value === 'string' && /^\/(?!\/)/.test(value) && !/[\\\u0000-\u001f\u007f]/.test(value) ? value : fallback;
}
