import type { RequestHandler, Router } from 'express';
import type { AppContext } from '../context.js';
import type { User, Role } from './users.js';
import { sessionUser } from './google.js';
import { createAuthRouter, mcpAuthentication } from './oauth.js';

export { UserService, registerAuthCommands } from './users.js';
export type { Role, User, Settings } from './users.js';

declare global {
  namespace Express { interface Request { user?: User } }
}

export function authRouter(ctx: AppContext): Router { return createAuthRouter(ctx); }
export function requireUser(ctx: AppContext, minRole: Role = 'viewer'): RequestHandler {
  const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
  return (req, res, next) => {
    const user = sessionUser(ctx, req);
    if (!user) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Login required' } });
      return;
    }
    if (rank[user.role] < rank[minRole]) {
      res.status(403).json({ error: { code: 'forbidden', message: `${minRole} role required` } });
      return;
    }
    req.user = user;
    next();
  };
}
export function requireMcpAuth(ctx: AppContext): RequestHandler { return mcpAuthentication(ctx); }
