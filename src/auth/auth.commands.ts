import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from './users.service.js';
import { UserServiceError, type Role } from './users.types.js';

export function registerAuthCommands(
  program: Command,
  getApp: () => Promise<INestApplicationContext>,
): void {
  const users = program.command('user').description('Manage users and recover administrator access');
  users.command('add <email>')
    .description('Register a user')
    .requiredOption('--role <role>', 'admin, editor, or viewer')
    .option('--name <name>', 'Display name')
    .action(async (email: string, options: { role: Role; name?: string }) => {
      const app = await getApp();
      const audit = app.get(AuditService);
      try {
        const user = app.get(UsersService).create({ email, role: options.role, name: options.name });
        audit.record({ actorId: null, action: 'user.create', target: email, outcome: 'success', summary: options.role });
        console.log(JSON.stringify(user, null, 2));
      } catch (error) {
        audit.record({ actorId: null, action: 'user.create', target: email, outcome: 'error' });
        throw error;
      }
    });
  users.command('role <email> <role>')
    .description('Change a user role')
    .action(async (email: string, role: Role) => {
      const app = await getApp();
      const service = app.get(UsersService);
      const audit = app.get(AuditService);
      try {
        const user = service.getByEmail(email);
        if (!user) throw new UserServiceError(404, 'not_found', 'User not found');
        const updated = service.update(user.id, { role });
        audit.record({ actorId: null, action: 'user.role', target: email, outcome: 'success', summary: role });
        console.log(JSON.stringify(updated, null, 2));
      } catch (error) {
        audit.record({ actorId: null, action: 'user.role', target: email, outcome: 'error' });
        throw error;
      }
    });
  users.command('list')
    .description('List registered users')
    .action(async () => {
      const app = await getApp();
      console.log(JSON.stringify(app.get(UsersService).list(), null, 2));
    });
}
