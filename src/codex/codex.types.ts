/** Short-lived ChatGPT credentials for calling the Codex Responses backend. */
export interface CodexAccess {
  accessToken: string;
  accountId: string;
}

/** Engine-owned ChatGPT (Codex OAuth) credential source stored in SQLite. */
export interface CodexCredentialSource {
  /** Returns a valid access token, refreshing first when it is near expiry. Throws CodexNotLoggedInError when no login is stored. */
  getAccess(): Promise<CodexAccess>;
  /** Forces a refresh (used after a 401) and returns the new access token. */
  refreshAccess(): Promise<CodexAccess>;
  /** True when credentials are stored; synchronous so availability checks stay cheap. */
  isLoggedIn(): boolean;
}

export class CodexNotLoggedInError extends Error {
  constructor() {
    super('ChatGPT(Codex) 로그인이 필요해요. 관리자에게 `pnpm cli codex login` 실행을 요청해 주세요.');
    this.name = 'CodexNotLoggedInError';
  }
}
