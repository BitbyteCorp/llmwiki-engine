import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
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
      console.log(JSON.stringify(app.get(UsersService).create({ email, role: options.role, name: options.name }), null, 2));
    });
  users.command('role <email> <role>')
    .description('Change a user role')
    .action(async (email: string, role: Role) => {
      const app = await getApp();
      const service = app.get(UsersService);
      const user = service.getByEmail(email);
      if (!user) throw new UserServiceError(404, 'not_found', 'User not found');
      console.log(JSON.stringify(service.update(user.id, { role }), null, 2));
    });
  users.command('list')
    .description('List registered users')
    .action(async () => {
      const app = await getApp();
      console.log(JSON.stringify(app.get(UsersService).list(), null, 2));
    });
}
