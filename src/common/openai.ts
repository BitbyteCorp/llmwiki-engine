import OpenAI from 'openai';
import type { Config } from '../config.js';
import { createCodexFetch } from '../codex/codex-transport.js';
import { CodexNotLoggedInError, type CodexCredentialSource } from '../codex/codex.types.js';

const durationUnits = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
const retryMarginMs = 250;

export function parseRateLimitDuration(value: string | null): number | undefined {
  if (!value) return undefined;
  const parts = /(\d+(?:\.\d*)?|\.\d+)(ms|h|m|s)/gy;
  let offset = 0;
  let milliseconds = 0;
  while (offset < value.length) {
    const part = parts.exec(value);
    if (!part) return undefined;
    milliseconds += Number(part[1]) * durationUnits[part[2] as keyof typeof durationUnits];
    offset = parts.lastIndex;
  }
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

export const rateLimitAwareFetch: typeof fetch = async (...args) => {
  const response = await globalThis.fetch(...args);
  if (response.status !== 429 || response.headers.has('retry-after-ms') || response.headers.has('retry-after')) {
    return response;
  }

  const tokens = parseRateLimitDuration(response.headers.get('x-ratelimit-reset-tokens'));
  const requests = parseRateLimitDuration(response.headers.get('x-ratelimit-reset-requests'));
  let delay = tokens === undefined ? requests : requests === undefined ? tokens : Math.max(tokens, requests);
  if (delay === undefined) {
    try {
      const body = await response.clone().text();
      const hint = /try again in\s+((?:(?:\d+(?:\.\d+)?|\.\d+)(?:ms|h|m|s))+)/i.exec(body);
      delay = parseRateLimitDuration(hint?.[1] ?? null);
    } catch {
      // Leave unreadable error bodies to the SDK's normal error/retry handling.
      return response;
    }
  }
  if (delay === undefined) return response;

  const headers = new Headers(response.headers);
  headers.set('retry-after-ms', String(Math.ceil(delay + retryMarginMs)));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export function createOpenAI(
  config: Pick<Config, 'openaiApiKey' | 'openaiBaseUrl'> & Partial<Pick<Config, 'openaiMaxRetries'>>,
): OpenAI {
  return new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
    maxRetries: config.openaiMaxRetries ?? 8,
    fetch: rateLimitAwareFetch,
  });
}

/** The Platform client remains separate because Codex has no embeddings endpoint. */
export function createLlmClient(
  config: Config,
  codex?: CodexCredentialSource,
): OpenAI {
  if (config.llmProvider !== 'openai-codex') return createOpenAI(config);
  if (!codex) throw new CodexNotLoggedInError();
  return new OpenAI({
    apiKey: 'codex-oauth',
    baseURL: config.codexBaseUrl ?? 'https://chatgpt.com/backend-api/codex',
    maxRetries: config.openaiMaxRetries ?? 8,
    fetch: createCodexFetch(codex),
  });
}

export function llmAvailable(config: Pick<Config, 'llmProvider' | 'openaiApiKey'>, codex?: CodexCredentialSource): boolean {
  return config.llmProvider === 'openai-codex' ? Boolean(codex?.isLoggedIn()) : Boolean(config.openaiApiKey);
}
