import type { User } from '../auth/users.types.js';

export type Access = 'none' | 'read' | 'write';
export type AclUser = Pick<User, 'id' | 'role'>;

export interface AclRule {
  id: number;
  prefix: string;
  subjectType: 'user' | 'role' | 'everyone';
  subject: string;
  access: Access;
  createdBy: number;
  createdAt: string;
}

export interface AclExplanation {
  userId: number;
  path: string;
  access: Access;
  rule: AclRule | null;
  reason: 'admin' | 'rule' | 'role_default';
}
