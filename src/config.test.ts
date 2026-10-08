import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('LLM compact threshold configuration', () => {
  it('defaults to a 50000-token compaction threshold', () => {
    expect(loadConfig({}).llmCompactThreshold).toBe(50000);
  });

  it('accepts a positive integer override for the agent context budget', () => {
    expect(loadConfig({ LLM_COMPACT_THRESHOLD: '160000' }).llmCompactThreshold).toBe(160000);
  });

  it.each(['', '0', '-1', '1.5', 'not-a-number', 'Infinity'])('rejects invalid threshold %j', (value) => {
    expect(() => loadConfig({ LLM_COMPACT_THRESHOLD: value })).toThrowError(/LLM_COMPACT_THRESHOLD/);
  });
});

describe('background reasoning effort configuration', () => {
  it('defaults background work to low without changing interactive reasoning', () => {
    expect(loadConfig({})).toMatchObject({ llmReasoningEffort: 'medium', llmBackgroundReasoningEffort: 'low' });
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])('accepts background effort %s independently of interactive effort', (effort) => {
    expect(loadConfig({ LLM_REASONING_EFFORT: 'high', LLM_BACKGROUND_REASONING_EFFORT: effort }))
      .toMatchObject({ llmReasoningEffort: 'high', llmBackgroundReasoningEffort: effort });
  });

  it.each(['', 'LOW', ' medium ', 'unsupported'])('rejects invalid background effort %j', (effort) => {
    expect(() => loadConfig({ LLM_BACKGROUND_REASONING_EFFORT: effort })).toThrowError(/LLM_BACKGROUND_REASONING_EFFORT/);
  });
});
