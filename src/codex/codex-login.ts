import { createServer, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import type { CodexAuthService } from './codex-auth.service.js';
import { CODEX_REDIRECT_URI, createCodexLogin, exchangeCodexCode, parseCodexCallback } from './codex-oauth.js';

interface CodexLoginOptions {
  input?: Readable & { isTTY?: boolean };
  output?: Writable;
  issuer?: string;
  port?: number;
  timeoutMs?: number;
  exchangeCode?: typeof exchangeCodexCode;
}

// Only fixed, bounded messages reach the browser; never reflect OAuth input or errors.
function page(response: ServerResponse, status: number, message: string, flushed?: () => void): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'Connection': 'close',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(`<!doctype html><html><head><title>Codex login</title></head><body><p>${message}</p></body></html>`, flushed);
}

export async function runCodexLogin(
  service: Pick<CodexAuthService, 'saveLogin'>,
  options: CodexLoginOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const login = createCodexLogin(options.issuer);
  const exchange = options.exchangeCode ?? exchangeCodexCode;
  const port = options.port ?? 1455;
  const completion = Promise.withResolvers<void>();
  let claimed = false;
  let settled = false;
  let browser: ServerResponse | undefined;
  // Like password input, readline edits a TTY but writes every echo to a sink.
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input, output: muted, terminal: input.isTTY === true });

  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    if (request.method !== 'GET') {
      page(response, 405, 'Only GET callbacks are accepted.');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '', CODEX_REDIRECT_URI);
    } catch {
      page(response, 400, 'Invalid callback. Continue the login in your terminal.');
      return;
    }
    if (url.pathname !== '/auth/callback') {
      page(response, 404, 'Not found.');
      return;
    }
    void accept(url.href, response);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  const cleanup = (preserveBrowser = false): void => {
    clearTimeout(timer);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    reader.removeListener('SIGINT', onInterrupt);
    reader.removeListener('line', onLine);
    reader.removeListener('error', onInputError);
    input.removeListener('error', onInputError);
    reader.close();
    muted.end();
    server.close();
    if (!preserveBrowser) server.closeAllConnections();
  };
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    if (browser && !browser.destroyed) {
      // Stop accepting connections now, then let the bounded result page flush.
      cleanup(true);
      const closeConnections = (): void => { server.closeAllConnections(); };
      browser.once('close', closeConnections);
      page(browser, error ? 500 : 200, error
        ? 'Login failed. Start a new login in your terminal.'
        : 'Login complete. You may close this window.', closeConnections);
    } else {
      cleanup();
    }
    if (error) completion.reject(error);
    else completion.resolve();
  };
  const onInterrupt = (): void => finish(new Error('Codex login cancelled.'));
  const onInputError = (): void => finish(new Error('Codex callback input failed. Start a new login.'));
  const onLine = (line: string): void => { void accept(line); };
  const timer = setTimeout(() => finish(new Error('Codex login timed out after 10 minutes. Start a new login.')), options.timeoutMs ?? 10 * 60_000);

  async function accept(value: string, response?: ServerResponse): Promise<void> {
    if (claimed || settled) {
      if (response) page(response, 409, 'A login is already completing. Return to your terminal.');
      return;
    }
    let code: string;
    try {
      code = parseCodexCallback(value, login.state);
    } catch {
      if (response) page(response, 400, 'Invalid callback or state. Continue the original login in your terminal.');
      else output.write('Invalid callback or state; paste the full redirect URL or code#state from this login.\n');
      return;
    }
    // Claim synchronously before awaiting the exchange: browser and paste can race.
    claimed = true;
    browser = response;
    try {
      const tokens = await exchange(code, login.verifier, options.issuer);
      if (settled) return; // Cancellation must not persist a late exchange result.
      service.saveLogin(tokens);
      output.write('Codex login complete.\n');
      finish();
    } catch {
      finish(new Error('Codex login failed. Start a new login with `pnpm cli codex login`.'));
    }
  }

  reader.on('line', onLine);
  reader.on('error', onInputError);
  reader.on('SIGINT', onInterrupt);
  input.on('error', onInputError);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  server.on('error', () => {
    if (settled) return;
    output.write(`Could not bind 127.0.0.1:${port}. Another process may own the port. Continue by pasting the full redirect URL or code#state here. For browser callbacks, free port 1455 and use ssh -L 1455:localhost:1455 on a remote host.\n`);
  });
  output.write(`Open this URL in your browser:\n${login.authorizationUrl}\n`);
  output.write('Waiting up to 10 minutes. Paste the full redirect URL or code#state here (input hidden), or press Ctrl-C to cancel.\n');
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') output.write(`Listening on http://127.0.0.1:${address.port}/auth/callback\n`);
  });
  await completion.promise;
}
