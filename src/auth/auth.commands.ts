import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from './users.service.js';
import { UserServiceError, type Role } from './users.types.js';
import { SessionsService } from './sessions.service.js';

export async function readPassword(
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable = process.stderr,
): Promise<string> {
  const terminal = input.isTTY === true;
  // readline can edit a TTY line, but its output must never echo secret input.
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input, output: muted, terminal });
  const cancelled = new UserServiceError(400, 'invalid_request', 'Password input cancelled');
  try {
    if (!terminal) {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      reader.once('line', resolve);
      reader.once('close', () => reject(cancelled));
      reader.once('error', reject);
      return await promise;
    }
    const question = async (prompt: string): Promise<string> => {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const onClose = () => reject(cancelled);
      const onInterrupt = () => reject(cancelled);
      reader.once('close', onClose);
      reader.once('SIGINT', onInterrupt);
      reader.once('error', reject);
      output.write(prompt);
      reader.question('', resolve);
      try {
        return await promise;
      } finally {
        reader.removeListener('close', onClose);
        reader.removeListener('SIGINT', onInterrupt);
        reader.removeListener('error', reject);
        output.write('\n');
      }
    };
    const password = await question('Password: ');
    const confirmation = await question('Confirm password: ');
    if (password !== confirmation) {
      throw new UserServiceError(400, 'invalid_request', 'Passwords do not match');
    }
    return password;
  } finally {
    reader.close();
    muted.end();
  }
}

export function registerAuthCommands(
  program: Command,
  getApp: () => Promise<INestApplicationContext>,
): void {
  const users = program.command('user').description('Manage users and recover administrator access');
  const argumentError = (_message: string, write: (message: string) => void) => {
    write('Invalid user command arguments; supply passwords through stdin, never arguments.\n');
  };
  users.command('add <email>')
    .description('Register a user')
    .configureOutput({ outputError: argumentError })
    .requiredOption('--role <role>', 'admin, editor, or viewer')
    .option('--name <name>', 'Display name')
    .option('--password', 'Read a password from stdin (hidden and confirmed on a TTY)')
    .action(async (email: string, options: { role: Role; name?: string; password?: boolean }) => {
      const app = await getApp();
      const audit = app.get(AuditService);
      try {
        const password = options.password ? await readPassword() : undefined;
        const user = await app.get(UsersService).create({ email, role: options.role, name: options.name, password });
        audit.record({ actorId: null, action: 'user.create', target: email, outcome: 'success', summary: options.role });
        if (options.password) audit.record({ actorId: null, action: 'user.password.set', target: email, outcome: 'success' });
        console.log(JSON.stringify(user, null, 2));
      } catch (error) {
        audit.record({ actorId: null, action: 'user.create', target: email, outcome: 'error' });
        if (options.password) audit.record({ actorId: null, action: 'user.password.set', target: email, outcome: 'error' });
        throw error;
      }
    });
  users.command('password <email>')
    .description('Set or clear a user password for administrator recovery')
    .configureOutput({ outputError: argumentError })
    .option('--clear', 'Remove the password without reading stdin')
    .action(async (email: string, options: { clear?: boolean }) => {
      const app = await getApp();
      const service = app.get(UsersService);
      const audit = app.get(AuditService);
      const action = options.clear ? 'user.password.clear' : 'user.password.set';
      try {
        const user = service.getByEmail(email);
        if (!user) throw new UserServiceError(404, 'not_found', 'User not found');
        const onChanged = () => app.get(SessionsService).revokeUser(user.id);
        if (options.clear) service.clearPassword(user.id, onChanged);
        else await service.setPassword(user.id, await readPassword(), onChanged);
        audit.record({ actorId: null, action, target: email, outcome: 'success' });
        console.log(JSON.stringify(service.getById(user.id), null, 2));
      } catch (error) {
        audit.record({ actorId: null, action, target: email, outcome: 'error' });
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
