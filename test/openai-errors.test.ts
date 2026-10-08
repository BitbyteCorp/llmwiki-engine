import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { classifyAnswerError } from '../src/common/openai-errors.js';

function providerError(status: number, code?: string, message = 'Private provider detail') {
  return OpenAI.APIError.generate(status, { error: { message, code } }, undefined, new Headers({ 'x-request-id': 'req_private' }));
}

describe('answer failure classification', () => {
  it.each([401, 403])('classifies HTTP %s as auth even when the provider also reports context exhaustion', status => {
    expect(classifyAnswerError(providerError(status, 'context_length_exceeded'))).toBe('auth');
  });

  it('keeps rate limiting ahead of context exhaustion and misleading cancellation text', () => {
    expect(classifyAnswerError(providerError(429, 'context_length_exceeded', 'Request cancelled after timeout'))).toBe('rate_limited');
  });

  it.each(['context_length_exceeded', 'context_window_exceeded'])('classifies structured %s ahead of generic invalid request', code => {
    expect(classifyAnswerError(providerError(400, code))).toBe('context_too_large');
  });

  it('keeps HTTP timeout ahead of context exhaustion', () => {
    expect(classifyAnswerError(providerError(408, 'context_length_exceeded'))).toBe('timeout');
  });

  it('classifies SDK connection timeouts ahead of generic connection failures', () => {
    expect(classifyAnswerError(new OpenAI.APIConnectionTimeoutError({ message: 'context_length_exceeded' }))).toBe('timeout');
    expect(classifyAnswerError(new OpenAI.APIConnectionError({ message: 'timeout' }))).toBe('provider_error');
  });

  it('classifies SDK cancellation ahead of misleading provider message text', () => {
    expect(classifyAnswerError(new OpenAI.APIUserAbortError({ message: 'Dony exceeded maxTurns (32) before finishing' }))).toBe('cancelled');
  });

  it.each([
    ['AbortError', 'cancelled'],
    ['TimeoutError', 'timeout'],
  ] as const)('recognizes native %s by error identity rather than message text', (name, reason) => {
    expect(classifyAnswerError(new DOMException('context_length_exceeded', name))).toBe(reason);
  });

  it.each([
    [400, 'invalid_request'],
    [422, 'invalid_request'],
    [500, 'provider_error'],
    [503, 'provider_error'],
  ] as const)('classifies HTTP %s without interpreting raw provider text', (status, reason) => {
    expect(classifyAnswerError(providerError(status, undefined, 'Rate limit exceeded; context too large; timeout; request cancelled'))).toBe(reason);
  });

  it.each([
    undefined,
    null,
    'context_length_exceeded',
    { status: 429, code: 'context_length_exceeded', name: 'AbortError' },
    new Error('timeout; request cancelled; context_length_exceeded; HTTP 429'),
    new Error('Provider detail: Dony exceeded maxTurns (32) before finishing'),
  ])('keeps unrecognized errors unknown instead of trusting arbitrary error text or object fields', error => {
    expect(classifyAnswerError(error)).toBe('unknown');
  });
});
