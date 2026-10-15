import { Inject, Injectable } from '@nestjs/common';
import { CodexCredentialsRepository, type CodexCredentialRow } from './codex-credentials.repository.js';
import { CODEX_OAUTH_ISSUER, codexTokenMetadata, refreshCodexTokens, type CodexTokens } from './codex-oauth.js';
import { CodexNotLoggedInError, type CodexAccess, type CodexCredentialSource } from './codex.types.js';

export type CodexStatus = { loggedIn: false } | {
  loggedIn: true; email: string | null; accountId: string; expiresAt: string;
};

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

@Injectable()
export class CodexAuthService implements CodexCredentialSource {
  private refreshing: Promise<CodexAccess> | undefined;

  constructor(
    private readonly repository: CodexCredentialsRepository,
    @Inject(CODEX_OAUTH_ISSUER) private readonly issuer: string,
  ) {}

  isLoggedIn(): boolean {
    return this.repository.exists();
  }

  async getAccess(): Promise<CodexAccess> {
    if (this.refreshing) return this.refreshing;
    const row = this.repository.get();
    if (!row) throw new CodexNotLoggedInError();
    if (Date.parse(row.expires_at) <= Date.now() + REFRESH_MARGIN_MS) return this.refreshAccess();
    return { accessToken: row.access_token, accountId: row.account_id };
  }

  refreshAccess(): Promise<CodexAccess> {
    if (this.refreshing) return this.refreshing;
    const pending = this.refreshStoredAccess();
    this.refreshing = pending;
    // Both settlement paths clear the shared promise without creating an unhandled rejected promise.
    void pending.then(() => { this.refreshing = undefined; }, () => { this.refreshing = undefined; });
    return pending;
  }

  private async refreshStoredAccess(): Promise<CodexAccess> {
    const previous = this.repository.get();
    if (!previous) throw new CodexNotLoggedInError();
    const tokens = await refreshCodexTokens(previous.refresh_token, this.issuer);
    const row = this.credentialRow(tokens, previous);
    if (this.repository.replace(previous, row)) return { accessToken: row.access_token, accountId: row.account_id };
    const current = this.repository.get();
    if (!current) throw new CodexNotLoggedInError();
    return { accessToken: current.access_token, accountId: current.account_id };
  }

  saveLogin(tokens: CodexTokens): void {
    this.repository.save(this.credentialRow(tokens));
  }

  status(): CodexStatus {
    const row = this.repository.get();
    return row ? { loggedIn: true, email: row.email, accountId: row.account_id, expiresAt: row.expires_at } : { loggedIn: false };
  }

  logout(): void {
    this.repository.delete();
  }

  private credentialRow(tokens: CodexTokens, previous?: CodexCredentialRow): CodexCredentialRow {
    const refreshToken = tokens.refresh_token ?? previous?.refresh_token;
    if (!refreshToken) throw new Error('Codex OAuth returned no refresh token; run `pnpm cli codex login` again');
    const idToken = tokens.id_token ?? previous?.id_token ?? undefined;
    const metadata = codexTokenMetadata({ ...tokens, id_token: idToken });
    return {
      access_token: tokens.access_token, refresh_token: refreshToken, id_token: idToken ?? null,
      account_id: metadata.accountId, email: metadata.email, expires_at: metadata.expiresAt,
      updated_at: new Date().toISOString(),
    };
  }
}
