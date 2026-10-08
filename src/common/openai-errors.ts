import OpenAI from 'openai';
import { z } from 'zod';

export const answerErrorCodeSchema = z.enum([
  'rate_limited', 'invalid_request', 'auth', 'provider_error', 'timeout',
  'context_too_large', 'turn_limit', 'cancelled', 'unknown',
]);
export type AnswerErrorCode = z.infer<typeof answerErrorCodeSchema>;

/** Only this allowlisted reason is safe to persist or send to chat clients. */
export function classifyAnswerError(error: unknown): AnswerErrorCode {
  if (error instanceof OpenAI.APIUserAbortError) return 'cancelled';
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403) return 'auth';
    if (error.status === 429) return 'rate_limited';
    if (error.status === 408) return 'timeout';
    if (error.code === 'context_length_exceeded' || error.code === 'context_window_exceeded') return 'context_too_large';
    if (error instanceof OpenAI.APIConnectionError || (error.status !== undefined && error.status >= 500)) return 'provider_error';
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return 'invalid_request';
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'cancelled';
    if (error.name === 'TimeoutError') return 'timeout';
    // runAgent currently exposes its local turn limit as an untyped Error.
    if (/^Dony exceeded maxTurns \(\d+\) before finishing$/u.test(error.message)) return 'turn_limit';
  }
  return 'unknown';
}
