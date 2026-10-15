import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAuthService } from './codex-auth.service.js';
import { CodexCredentialsRepository } from './codex-credentials.repository.js';
import { createCodexLogin, exchangeCodexCode, parseCodexCallback, type CodexTokens } from './codex-oauth.js';
import { CodexNotLoggedInError } from './codex.types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function tokens(expiresIn = 3600, refreshToken = 'refresh-first'): CodexTokens {
  return {
    access_token: jwt({ exp: Math.floor(Date.now() / 1000) + expiresIn, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } }),
    refresh_token: refreshToken,
    id_token: jwt({ email: 'admin@example.com' }),
    expires_in: expiresIn,
  };
}

async function setup() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../db/migrations/029_codex_credentials.sql', import.meta.url), 'utf8'));
  const requests: URLSearchParams[] = [];
  let reply: CodexTokens = tokens();
  let status = 200;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/oauth/token') { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    requests.push(new URLSearchParams(body));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? reply : { error: 'invalid_grant', error_description: 'sensitive-provider-detail' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const issuer = `http://127.0.0.1:${address.port}`;
  const repository = new CodexCredentialsRepository(db);
  const service = new CodexAuthService(repository, issuer);
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    db.close();
  });
  return {
    service, repository, issuer, requests,
    setReply(value: CodexTokens, code = 200) { reply = value; status = code; },
  };
}

describe('Codex OAuth credentials', () => {
  it('exchanges the PKCE code and persists engine-owned credentials across service instances', async () => {
    const fixture = await setup();
    const login = createCodexLogin(fixture.issuer);
    const authorization = new URL(login.authorizationUrl);
    expect(authorization.pathname).toBe('/oauth/authorize');
    expect(authorization.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(authorization.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(authorization.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBe(createHash('sha256').update(login.verifier).digest('base64url'));
    expect(login.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(login.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const code = parseCodexCallback(`http://localhost:1455/auth/callback?code=code-test&state=${login.state}`, login.state);
    const exchanged = await exchangeCodexCode(code, login.verifier, fixture.issuer);
    fixture.service.saveLogin(exchanged);
    const restored = new CodexAuthService(fixture.repository, fixture.issuer);
    expect(await restored.getAccess()).toEqual({ accessToken: exchanged.access_token, accountId: 'account-test' });
    expect(restored.status()).toMatchObject({ loggedIn: true, email: 'admin@example.com', accountId: 'account-test' });
    expect(fixture.requests[0]!.get('grant_type')).toBe('authorization_code');
    expect(fixture.requests[0]!.get('code')).toBe('code-test');
    expect(fixture.requests[0]!.get('code_verifier')).toBe(login.verifier);
    expect(fixture.requests[0]!.has('client_secret')).toBe(false);
  });

  it('refreshes near expiry, persists rotated refresh tokens, and preserves tokens omitted by refresh', async () => {
    const fixture = await setup();
    fixture.service.saveLogin(tokens(240));
    const rotated = {
      ...tokens(3600, 'refresh-rotated'),
      id_token: jwt({ email: 'admin@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'account-fallback' } }),
    };
    fixture.setReply(rotated);
    expect(await fixture.service.getAccess()).toEqual({ accessToken: rotated.access_token, accountId: 'account-test' });
    expect(fixture.requests[0]!.get('refresh_token')).toBe('refresh-first');
    fixture.setReply({ access_token: 'opaque-access', expires_in: 7200 });
    const restored = new CodexAuthService(fixture.repository, fixture.issuer);
    expect(await restored.refreshAccess()).toEqual({ accessToken: 'opaque-access', accountId: 'account-fallback' });
    expect(fixture.requests[1]!.get('refresh_token')).toBe('refresh-rotated');
    expect(restored.status()).toMatchObject({ email: 'admin@example.com', accountId: 'account-fallback' });
    await restored.refreshAccess();
    expect(fixture.requests[2]!.get('refresh_token')).toBe('refresh-rotated');
  });

  it('shares a single refresh between concurrent callers', async () => {
    const fixture = await setup();
    fixture.service.saveLogin(tokens(120));
    const rotated = tokens(3600, 'refresh-shared');
    fixture.setReply(rotated);
    const results = await Promise.all([fixture.service.getAccess(), fixture.service.getAccess()]);
    expect(results).toEqual([
      { accessToken: rotated.access_token, accountId: 'account-test' },
      { accessToken: rotated.access_token, accountId: 'account-test' },
    ]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]!.get('grant_type')).toBe('refresh_token');
  });

  it.each([400, 401])('asks the administrator to log in again on refresh rejection %s without exposing provider details', async (status) => {
    const fixture = await setup();
    fixture.service.saveLogin(tokens(120));
    fixture.setReply(tokens(), status);
    await expect(fixture.service.getAccess()).rejects.toThrow('Run `pnpm cli codex login` again');
    try { await fixture.service.refreshAccess(); } catch (error) {
      expect(String(error)).not.toContain('sensitive-provider-detail');
      expect(String(error)).not.toContain('refresh-first');
    }
  });

  it('rejects mismatched callback state before exchanging a code and accepts a pasted code#state', async () => {
    const fixture = await setup();
    const login = createCodexLogin(fixture.issuer);
    expect(() => parseCodexCallback('http://localhost:1455/auth/callback?code=not-exchanged&state=wrong', login.state))
      .toThrow('state mismatch');
    expect(fixture.requests).toHaveLength(0);
    expect(parseCodexCallback(`pasted-code#${login.state}`, login.state)).toBe('pasted-code');
    expect(() => parseCodexCallback(`https://wiki.example.com/auth/callback?code=wrong&state=${login.state}`, login.state))
      .toThrow('localhost:1455');
  });

  it('does not restore a login after logout races an in-flight refresh', async () => {
    const fixture = await setup();
    fixture.service.saveLogin(tokens(120));
    const pending = fixture.service.getAccess();
    fixture.service.logout();
    await expect(pending).rejects.toBeInstanceOf(CodexNotLoggedInError);
    expect(fixture.service.isLoggedIn()).toBe(false);
    expect(fixture.service.status()).toEqual({ loggedIn: false });
    await expect(fixture.service.getAccess()).rejects.toBeInstanceOf(CodexNotLoggedInError);
  });

  it('uses ID-token account claims and expires_in when access tokens have no JWT metadata', async () => {
    const fixture = await setup();
    fixture.service.saveLogin({
      access_token: 'opaque-access', refresh_token: 'refresh-opaque', expires_in: 3600,
      id_token: jwt({ email: 'fallback@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'account-fallback' } }),
    });
    expect(await fixture.service.getAccess()).toEqual({ accessToken: 'opaque-access', accountId: 'account-fallback' });
    expect(fixture.service.status()).toMatchObject({ email: 'fallback@example.com', accountId: 'account-fallback' });
    expect(fixture.requests).toHaveLength(0);
  });
});
