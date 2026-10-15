import { once } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCodexLogin } from './codex-login.js';
import { CODEX_REDIRECT_URI, type CodexTokens, type exchangeCodexCode } from './codex-oauth.js';

const tokens: CodexTokens = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 };
const sessions: { input: PassThrough; pending: Promise<void> }[] = [];

afterEach(async () => {
  for (const { input } of sessions) {
    if (input.listenerCount('data') > 0) input.emit('error', new Error('Test cleanup'));
  }
  await Promise.allSettled(sessions.map(({ pending }) => pending));
  for (const { input } of sessions.splice(0)) input.destroy();
});

function login(exchangeCode: typeof exchangeCodexCode = vi.fn(async () => tokens), timeoutMs = 5_000, port = 0) {
  const input = new PassThrough();
  const service = { saveLogin: vi.fn() };
  let printed = '';
  const listening = Promise.withResolvers<URL>();
  const output = new Writable({ write(chunk, _encoding, callback) {
    printed += String(chunk);
    const address = printed.match(/Listening on (http:\/\/127\.0\.0\.1:\d+\/auth\/callback)/)?.[1];
    if (address) listening.resolve(new URL(address));
    callback();
  } });
  const pending = runCodexLogin(service, { input, output, exchangeCode, timeoutMs, port });
  sessions.push({ input, pending });
  void pending.catch(() => {});
  return { input, service, exchangeCode, pending, listening: listening.promise, output: () => printed,
    state: () => new URL(printed.match(/https:\/\/auth\.openai\.com\/\S+/)![0]).searchParams.get('state')! };
}

describe('Codex login completion', () => {
  it('rejects a wrong state without exchange and still accepts the legitimate browser callback', async () => {
    const session = login();
    const callback = await session.listening;
    const authorize = new URL(session.output().match(/https:\/\/auth\.openai\.com\/\S+/)![0]);
    expect(authorize.searchParams.get('redirect_uri')).toBe(CODEX_REDIRECT_URI);
    callback.search = new URLSearchParams({ code: 'browser-code', state: 'wrong-state' }).toString();
    const rejected = await fetch(callback);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain('browser-code');
    expect(session.exchangeCode).not.toHaveBeenCalled();
    callback.searchParams.set('state', session.state());
    const accepted = await fetch(callback);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain('Login complete');
    await session.pending;
    expect(session.exchangeCode).toHaveBeenCalledExactlyOnceWith('browser-code', expect.any(String), undefined);
    expect(session.service.saveLogin).toHaveBeenCalledExactlyOnceWith(tokens);
    expect(session.input.listenerCount('data')).toBe(0);
    await expect(fetch(callback)).rejects.toThrow();
  });

  it.each(['url', 'shorthand'])('accepts a pasted %s only after state validation, and ignores a second completion', async (format) => {
    const exchanged = Promise.withResolvers<CodexTokens>();
    const exchangeCode = vi.fn(() => exchanged.promise);
    const session = login(exchangeCode);
    const callback = await session.listening;
    session.input.write('wrong-code#wrong-state\n');
    expect(exchangeCode).not.toHaveBeenCalled();
    const pasted = format === 'url'
      ? `${CODEX_REDIRECT_URI}?${new URLSearchParams({ code: 'pasted-code', state: session.state() })}`
      : `pasted-code#${session.state()}`;
    session.input.write(`${pasted}\nsecond-code#${session.state()}\n`);
    callback.search = new URLSearchParams({ code: 'browser-code', state: session.state() }).toString();
    const duplicate = await fetch(callback);
    expect(duplicate.status).toBe(409);
    await duplicate.text();
    expect(exchangeCode).toHaveBeenCalledExactlyOnceWith('pasted-code', expect.any(String), undefined);
    expect(session.service.saveLogin).not.toHaveBeenCalled();
    exchanged.resolve(tokens);
    await session.pending;
    expect(session.service.saveLogin).toHaveBeenCalledExactlyOnceWith(tokens);
    expect(session.input.listenerCount('data')).toBe(0);
    await expect(fetch(callback)).rejects.toThrow();
  });

  it('closes the listener and stdin on exchange failure without exposing the error contents', async () => {
    const session = login(vi.fn(async () => { throw new Error('secret-code-and-token'); }));
    const callback = await session.listening;
    const failed = expect(session.pending).rejects.toThrow('Codex login failed');
    session.input.write(`pasted-code#${session.state()}\n`);
    await failed;
    expect(session.service.saveLogin).not.toHaveBeenCalled();
    expect(session.output()).not.toContain('secret-code-and-token');
    expect(session.input.listenerCount('data')).toBe(0);
    await expect(fetch(callback)).rejects.toThrow();
  });

  it('times out and discards an exchange that finishes after cancellation', async () => {
    const exchanged = Promise.withResolvers<CodexTokens>();
    const session = login(vi.fn(() => exchanged.promise), 100);
    const timedOut = expect(session.pending).rejects.toThrow('timed out');
    const callback = await session.listening;
    session.input.write(`pasted-code#${session.state()}\n`);
    await timedOut;
    expect(session.input.listenerCount('data')).toBe(0);
    await expect(fetch(callback)).rejects.toThrow();
    exchanged.resolve(tokens);
    await exchanged.promise;
    expect(session.service.saveLogin).not.toHaveBeenCalled();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('cancels cleanly on %s and removes its signal handlers', async (signal) => {
    const before = process.listenerCount(signal);
    const session = login();
    const callback = await session.listening;
    const cancelled = expect(session.pending).rejects.toThrow('cancelled');
    process.emit(signal);
    await cancelled;
    expect(process.listenerCount(signal)).toBe(before);
    expect(session.input.listenerCount('data')).toBe(0);
    expect(session.exchangeCode).not.toHaveBeenCalled();
    expect(session.service.saveLogin).not.toHaveBeenCalled();
    await expect(fetch(callback)).rejects.toThrow();
  });

  it('allows remote paste when the loopback callback port is already occupied', async () => {
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    try {
      const address = occupied.address();
      if (!address || typeof address === 'string') throw new Error('Expected loopback address');
      const session = login(undefined, 5_000, address.port);
      await vi.waitFor(() => expect(session.output()).toContain('Could not bind'));
      expect(session.output()).toContain('pasting the full redirect URL or code#state');
      session.input.write(`${CODEX_REDIRECT_URI}?${new URLSearchParams({ code: 'remote-code', state: session.state() })}\n`);
      await session.pending;
      expect(session.exchangeCode).toHaveBeenCalledExactlyOnceWith('remote-code', expect.any(String), undefined);
      expect(session.service.saveLogin).toHaveBeenCalledExactlyOnceWith(tokens);
      expect(session.input.listenerCount('data')).toBe(0);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
