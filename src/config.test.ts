import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('LLM compact threshold configuration', () => {
  it('accepts a positive integer override for the agent context budget', () => {
    expect(loadConfig({ LLM_COMPACT_THRESHOLD: '160000' }).llmCompactThreshold).toBe(160000);
  });

  it.each(['', '0', '-1', '1.5', 'not-a-number', 'Infinity'])('rejects invalid threshold %j', (value) => {
    expect(() => loadConfig({ LLM_COMPACT_THRESHOLD: value })).toThrowError(/LLM_COMPACT_THRESHOLD/);
  });
});
