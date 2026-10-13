import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import type * as Readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { DB, CONFIG } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import { registerAuthCommands, readPassword } from './auth.commands.js';
import { SessionsService } from './sessions.service.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

const stdin = vi.hoisted(() => ({ input: undefined as PassThrough | undefined }));
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof Readline>();
  return { ...actual, createInterface: vi.fn((options: Readline.ReadLineOptions) => actual.createInterface({
    ...options, input: options.input === process.stdin && stdin.input ? stdin.input : options.input,
  })) };
});

class TerminalInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean): this { this.isRaw = mode; return this; }
}

let db: Database.Database;
let app: TestingModule;
let users: UsersService;
let logged: MockInstance<typeof console.log>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const name of ['001_core.sql', '002_auth.sql', '011_platform.sql', '013_acl.sql', '027_user_passwords.sql']) {
    db.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8'));
  }
  app = await Test.createTestingModule({ providers: [UsersRepository, UsersService, SessionsService, AuditService,
    { provide: DB, useValue: db },
    { provide: CONFIG, useValue: loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test-secret' }) },
  ] }).compile();
  users = app.get(UsersService);
  logged = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  stdin.input?.destroy();
  stdin.input = undefined;
  await app?.close();
  db?.close();
  vi.restoreAllMocks();
});

function command(): Command {
  const program = new Command().exitOverride();
  registerAuthCommands(program, async () => app);
  return program;
}

function pipedSecret(value: string): void {
  stdin.input = new PassThrough();
  stdin.input.end(value);
}

function events() {
  return app.get(AuditService).list({ limit: 100 }).events.map(({ action, outcome, actorId, target }) => ({ action, outcome, actorId, target }));
}

describe('CLI password input', () => {
  it('reads exactly the first non-TTY line without trimming or confirmation', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = readPassword(input, output);
    input.end('  correct password  \r\nignored second line\n');
    await expect(pending).resolves.toBe('  correct password  ');
    expect(output.read()).toBeNull();
  });

  it('rejects non-TTY EOF without any input', async () => {
    const input = new PassThrough();
    const pending = readPassword(input, new PassThrough());
    input.end();
    await expect(pending).rejects.toMatchObject({ code: 'invalid_request', message: 'Password input cancelled' });
  });

  it('hides TTY input, asks twice, and restores raw mode after confirmation', async () => {
    const input = new TerminalInput();
    let prompts = '';
    const output = new Writable({ write(chunk, _encoding, callback) {
      const prompt = String(chunk);
      prompts += prompt;
      if (prompt === 'Password: ' || prompt === 'Confirm password: ') queueMicrotask(() => input.write('correct password\r'));
      callback();
    } });
    await expect(readPassword(input, output)).resolves.toBe('correct password');
    expect(prompts).toBe('Password: \nConfirm password: \n');
    expect(input.isRaw).toBe(false);
    input.destroy();
  });

  it('rejects mismatched confirmation without exposing either secret', async () => {
    const input = new TerminalInput();
    let prompts = '';
    const output = new Writable({ write(chunk, _encoding, callback) {
      const prompt = String(chunk);
      prompts += prompt;
      if (prompt === 'Password: ') queueMicrotask(() => input.write('first password\r'));
      if (prompt === 'Confirm password: ') queueMicrotask(() => input.write('second password\r'));
      callback();
    } });
    await expect(readPassword(input, output)).rejects.toMatchObject({ code: 'invalid_request', message: 'Passwords do not match' });
    expect(prompts).not.toContain('first password');
    expect(prompts).not.toContain('second password');
    expect(input.isRaw).toBe(false);
    input.destroy();
  });

  it('restores raw mode after Ctrl-C', async () => {
    const input = new TerminalInput();
    const output = new Writable({ write(chunk, _encoding, callback) {
      if (String(chunk) === 'Password: ') queueMicrotask(() => input.write('\u0003'));
      callback();
    } });
    await expect(readPassword(input, output)).rejects.toMatchObject({ code: 'invalid_request', message: 'Password input cancelled' });
    expect(input.isRaw).toBe(false);
    input.destroy();
  });
});

describe('CLI password provisioning and recovery', () => {
  it('creates a user with a stdin password and prints only a safe user', async () => {
    pipedSecret('correct password\n');
    await command().parseAsync(['node', 'test', 'user', 'add', 'cli@example.com', '--role', 'admin', '--password']);
    expect(users.getByEmail('cli@example.com')).toMatchObject({ hasPassword: true, role: 'admin' });
    await expect(users.passwordLogin('cli@example.com', 'correct password')).resolves.toMatchObject({ email: 'cli@example.com' });
    const printed = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(printed)).toMatchObject({ hasPassword: true });
    expect(printed).not.toContain('correct password');
    expect(printed).not.toContain('scrypt$');
    expect(events()).toEqual([
      { actorId: null, action: 'user.password.set', target: 'cli@example.com', outcome: 'success' },
      { actorId: null, action: 'user.create', target: 'cli@example.com', outcome: 'success' },
    ]);
  });

  it('sets and clears passwords, auditing each change and revoking all sessions', async () => {
    const user = await users.create({ email: 'cli@example.com', role: 'admin' });
    db.prepare('INSERT INTO web_sessions(id_hash,user_id,expires_at) VALUES(?,?,?)').run('first-session', user.id, '2099-01-01T00:00:00.000Z');
    pipedSecret('correct password\n');
    await command().parseAsync(['node', 'test', 'user', 'password', user.email]);
    expect(users.getById(user.id)?.hasPassword).toBe(true);
    expect(db.prepare('SELECT * FROM web_sessions').all()).toEqual([]);
    db.prepare('INSERT INTO web_sessions(id_hash,user_id,expires_at) VALUES(?,?,?)').run('second-session', user.id, '2099-01-01T00:00:00.000Z');
    // Clearing must not wait for stdin or require confirmation.
    stdin.input = new PassThrough();
    await command().parseAsync(['node', 'test', 'user', 'password', user.email, '--clear']);
    expect(users.getById(user.id)?.hasPassword).toBe(false);
    expect(db.prepare('SELECT * FROM web_sessions').all()).toEqual([]);
    expect(events()).toEqual([
      { actorId: null, action: 'user.password.clear', target: user.email, outcome: 'success' },
      { actorId: null, action: 'user.password.set', target: user.email, outcome: 'success' },
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('correct password');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('scrypt$');
  });

  it('audits failures without changing existing credentials or exposing submitted passwords', async () => {
    const user = await users.create({ email: 'cli@example.com', role: 'admin', password: 'correct password' });
    pipedSecret('short\n');
    await expect(command().parseAsync(['node', 'test', 'user', 'password', user.email])).rejects.toMatchObject({ code: 'weak_password' });
    await expect(users.passwordLogin(user.email, 'correct password')).resolves.toMatchObject({ id: user.id });
    await expect(command().parseAsync(['node', 'test', 'user', 'password', 'missing@example.com', '--clear'])).rejects.toMatchObject({ code: 'not_found' });
    expect(events()).toEqual([
      { actorId: null, action: 'user.password.clear', target: 'missing@example.com', outcome: 'error' },
      { actorId: null, action: 'user.password.set', target: user.email, outcome: 'error' },
    ]);
    expect(logged).not.toHaveBeenCalled();
    expect(JSON.stringify(app.get(AuditService).list({ limit: 100 }))).not.toContain('correct password');
    expect(JSON.stringify(app.get(AuditService).list({ limit: 100 }))).not.toContain('short');
  });

  it.each([
    { args: ['user', 'add', 'cli@example.com', '--role', 'admin', '--password', 'argv-secret'] },
    { args: ['user', 'add', 'cli@example.com', '--role', 'admin', '--password=argv-secret'] },
    { args: ['user', 'password', 'cli@example.com', 'argv-secret'] },
    { args: ['user', 'password', 'cli@example.com', '--password=argv-secret'] },
  ])('rejects password arguments before reading input %#', async ({ args }) => {
    let errorOutput = '';
    const program = command().configureOutput({ writeErr: (message) => { errorOutput += message; } });
    await expect(program.parseAsync(['node', 'test', ...args])).rejects.toMatchObject({ name: 'CommanderError' });
    expect(errorOutput).not.toContain('argv-secret');
    expect(users.list()).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });
});
