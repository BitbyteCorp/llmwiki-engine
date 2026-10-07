import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Request, Response, RequestHandler } from 'express';
import { OAuthService } from '../oauth.service.js';
import { UsersService } from '../users.service.js';

@Injectable()
export class McpAuthGuard implements CanActivate {
  private readonly middleware: RequestHandler;

  constructor(oauth: OAuthService, private readonly users: UsersService) {
    this.middleware = requireBearerAuth({
      resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', oauth.issuerUrl()).href,
      expectedResource: new URL(oauth.resourceUrl()),
      verifier: { verifyAccessToken: (token) => oauth.verifyAccessToken(token) },
    });
  }

  canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        res.off('finish', denied);
        res.off('close', denied);
      };
      const denied = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      const next = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) { reject(error); return; }
        try {
          req.user = this.users.getById(Number(req.auth?.extra?.userId)) ?? undefined;
          resolve(true);
        } catch (lookupError) {
          reject(lookupError);
        }
      };
      // The SDK sends failures itself without calling next. Wait for the sent response,
      // so Nest's filter leaves the exact OAuth body and challenge untouched.
      res.once('finish', denied);
      res.once('close', denied);
      if (res.writableEnded || res.destroyed) { denied(); return; }
      try {
        Promise.resolve(this.middleware(req, res, next)).catch(next);
      } catch (error) {
        next(error);
      }
    });
  }
}
