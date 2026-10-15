import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CODEX_OAUTH_ISSUER = Symbol('CODEX_OAUTH_ISSUER');
export const DEFAULT_CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';

export interface CodexTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export class CodexOAuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'CodexOAuthError';
  }
}

export function createCodexLogin(issuer = DEFAULT_CODEX_OAUTH_ISSUER): {
  verifier: string; state: string; authorizationUrl: string;
} {
  const verifier = randomBytes(64).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const target = new URL('/oauth/authorize', issuer);
  target.search = new URLSearchParams({
    response_type: 'code', client_id: CODEX_CLIENT_ID, redirect_uri: CODEX_REDIRECT_URI,
    scope: 'openid profile email offline_access', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'llmwiki',
  }).toString();
  return { verifier, state, authorizationUrl: target.href };
}

/** Accept only the registered redirect URL or the CLI's code#state shorthand. */
export function parseCodexCallback(input: string, expectedState: string): string {
  const value = input.trim();
  let code: string | null;
  let state: string | null;
  let denied = false;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    let target: URL;
    try { target = new URL(value); } catch { throw new Error('Invalid Codex callback URL'); }
    const registered = new URL(CODEX_REDIRECT_URI);
    if (target.origin !== registered.origin || target.pathname !== registered.pathname || target.username || target.password
      || target.searchParams.getAll('state').length !== 1 || target.searchParams.getAll('code').length > 1) {
      throw new Error('Invalid Codex callback URL; use the localhost:1455 redirect URL');
    }
    code = target.searchParams.get('code');
    state = target.searchParams.get('state');
    denied = target.searchParams.has('error');
  } else {
    const parts = value.split('#');
    if (parts.length !== 2) throw new Error('Paste the full Codex redirect URL or code#state');
    [code, state] = parts as [string, string];
  }
  const received = Buffer.from(state ?? '');
  const expected = Buffer.from(expectedState);
  if (!state || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error('Codex callback state mismatch; use the redirect from this login attempt');
  }
  if (denied || !code) throw new Error('Codex login was denied or returned no authorization code');
  return code;
}

async function requestTokens(form: URLSearchParams, issuer: string): Promise<CodexTokens> {
  let response: Response;
  try {
    response = await fetch(new URL('/oauth/token', issuer), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form, signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
  } catch {
    throw new Error('Could not reach the Codex OAuth token endpoint');
  }
  if (!response.ok) {
    const refreshRejected = form.get('grant_type') === 'refresh_token' && (response.status === 400 || response.status === 401);
    await response.body?.cancel();
    throw new CodexOAuthError(response.status, refreshRejected
      ? 'Codex login has expired or been revoked. Run `pnpm cli codex login` again.'
      : `Codex OAuth token exchange failed (HTTP ${response.status})`);
  }
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('Codex OAuth returned an invalid token response'); }
  if (!value || typeof value !== 'object') throw new Error('Codex OAuth returned an invalid token response');
  const tokens = value as Record<string, unknown>;
  if (typeof tokens.access_token !== 'string' || !tokens.access_token
    || (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token))
    || (tokens.id_token !== undefined && (typeof tokens.id_token !== 'string' || !tokens.id_token))
    || (tokens.expires_in !== undefined && (typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))) {
    throw new Error('Codex OAuth returned an invalid token response');
  }
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token as string | undefined,
    id_token: tokens.id_token as string | undefined,
    expires_in: tokens.expires_in as number | undefined,
  };
}

export function exchangeCodexCode(code: string, verifier: string, issuer = DEFAULT_CODEX_OAUTH_ISSUER): Promise<CodexTokens> {
  return requestTokens(new URLSearchParams({
    grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID, code,
    redirect_uri: CODEX_REDIRECT_URI, code_verifier: verifier,
  }), issuer);
}

export function refreshCodexTokens(refreshToken: string, issuer = DEFAULT_CODEX_OAUTH_ISSUER): Promise<CodexTokens> {
  return requestTokens(new URLSearchParams({ grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: refreshToken }), issuer);
}

/** Decode metadata only: these tokens come directly from the trusted OAuth token endpoint, not a web login assertion. */
export function decodeCodexJwt(token: string): Record<string, unknown> {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return {};
    const payload: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  } catch { return {}; }
}

export function codexTokenMetadata(tokens: CodexTokens): { accountId: string; email: string | null; expiresAt: string } {
  const access = decodeCodexJwt(tokens.access_token);
  const identity = decodeCodexJwt(tokens.id_token ?? '');
  const account = (payload: Record<string, unknown>): string | undefined => {
    const claim = payload['https://api.openai.com/auth'];
    if (!claim || typeof claim !== 'object' || !('chatgpt_account_id' in claim)) return undefined;
    return typeof claim.chatgpt_account_id === 'string' && claim.chatgpt_account_id ? claim.chatgpt_account_id : undefined;
  };
  const accountId = account(access) ?? account(identity);
  if (!accountId) throw new Error('Codex OAuth tokens contain no ChatGPT account ID; run `pnpm cli codex login` again');
  const expiry = typeof access.exp === 'number' && Number.isFinite(access.exp) ? access.exp * 1000
    : typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? Date.now() + tokens.expires_in * 1000
      : typeof identity.exp === 'number' && Number.isFinite(identity.exp) ? identity.exp * 1000 : NaN;
  if (!Number.isFinite(expiry) || Math.abs(expiry) > 8.64e15 || expiry <= 0) throw new Error('Codex OAuth tokens contain no valid expiration');
  return { accountId, email: typeof identity.email === 'string' ? identity.email : null, expiresAt: new Date(expiry).toISOString() };
}
