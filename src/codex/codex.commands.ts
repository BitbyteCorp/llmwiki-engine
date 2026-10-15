import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import { CodexAuthService } from './codex-auth.service.js';
import { runCodexLogin } from './codex-login.js';

export function registerCodexCommands(
  program: Command,
  getApp: () => Promise<INestApplicationContext>,
): void {
  const codex = program.command('codex').description('Manage engine-owned ChatGPT (Codex) login');
  const argumentError = (_message: string, write: (message: string) => void): void => {
    write('Invalid Codex command arguments; paste callbacks through stdin, never arguments.\n');
  };
  codex.configureOutput({ outputError: argumentError });
  codex.command('login')
    .description('Log in through a browser callback or hidden stdin paste')
    .configureOutput({ outputError: argumentError })
    .action(async () => {
      const app = await getApp();
      await runCodexLogin(app.get(CodexAuthService));
    });
  codex.command('status')
    .description('Show login identity and expiry without credentials')
    .configureOutput({ outputError: argumentError })
    .action(async () => {
      const app = await getApp();
      const status = app.get(CodexAuthService).status();
      console.log(JSON.stringify(status.loggedIn ? {
        loggedIn: true,
        email: status.email,
        accountId: status.accountId,
        expiresAt: status.expiresAt,
      } : { loggedIn: false }, null, 2));
    });
  codex.command('logout')
    .description('Remove the engine-owned Codex login')
    .configureOutput({ outputError: argumentError })
    .action(async () => {
      const app = await getApp();
      app.get(CodexAuthService).logout();
      console.log('Codex login removed from this engine.');
    });
}
