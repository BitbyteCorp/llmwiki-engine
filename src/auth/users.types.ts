export type Role = 'admin' | 'editor' | 'viewer';

export interface User {
  id: number;
  email: string;
  name: string | null;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Settings {
  allowlistEnabled: boolean;
  allowedDomains: string[];
}

export class UserServiceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'UserServiceError';
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
