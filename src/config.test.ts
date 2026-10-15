import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('LLM provider configuration', () => {
  it('defaults to OpenAI without changing its models or base URL', () => {
    expect(loadConfig({})).toMatchObject({
      llmProvider: 'openai',
      openaiBaseUrl: undefined,
      llmModels: ['gpt-6-luna'],
      llmModel: 'gpt-6-luna',
      embeddingModel: 'text-embedding-3-small',
    });
  });

  it('defaults OpenRouter to its API URL and namespaced models', () => {
    expect(loadConfig({ LLM_PROVIDER: 'openrouter' })).toMatchObject({
      llmProvider: 'openrouter',
      openaiBaseUrl: 'https://openrouter.ai/api/v1',
      llmModels: ['openai/gpt-6-luna'],
      llmModel: 'openai/gpt-6-luna',
      embeddingModel: 'openai/text-embedding-3-small',
    });
  });

  it('defaults Codex to ChatGPT without redirecting Platform embeddings', () => {
    expect(loadConfig({ LLM_PROVIDER: 'openai-codex' })).toMatchObject({
      llmProvider: 'openai-codex',
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      openaiApiKey: undefined,
      openaiBaseUrl: undefined,
      llmModels: ['gpt-6-luna'],
      llmModel: 'gpt-6-luna',
      embeddingModel: 'text-embedding-3-small',
    });
  });

  it.each(['openai', 'openrouter', 'openai-codex'])('honors explicit overrides for %s and trims the model list', (provider) => {
    expect(loadConfig({
      LLM_PROVIDER: provider,
      OPENAI_API_KEY: 'provider-api-key',
      OPENAI_BASE_URL: 'https://example.com/api/v1',
      CODEX_BASE_URL: 'https://codex.example.com/backend-api/codex',
      LLM_MODELS: ' , custom/primary , , custom/secondary, ',
      EMBEDDING_MODEL: 'custom/embedding',
    })).toMatchObject({
      llmProvider: provider,
      openaiApiKey: 'provider-api-key',
      openaiBaseUrl: 'https://example.com/api/v1',
      codexBaseUrl: 'https://codex.example.com/backend-api/codex',
      llmModels: ['custom/primary', 'custom/secondary'],
      llmModel: 'custom/primary',
      embeddingModel: 'custom/embedding',
    });
  });

  it.each([
    { provider: 'openai', baseUrl: undefined, embeddingModel: 'text-embedding-3-small' },
    { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', embeddingModel: 'openai/text-embedding-3-small' },
    { provider: 'openai-codex', baseUrl: undefined, embeddingModel: 'text-embedding-3-small' },
  ])('uses provider defaults for empty optional settings with $provider', ({ provider, baseUrl, embeddingModel }) => {
    expect(loadConfig({
      LLM_PROVIDER: provider,
      OPENAI_BASE_URL: '',
      CODEX_BASE_URL: '',
      EMBEDDING_MODEL: '',
    })).toMatchObject({
      llmProvider: provider,
      openaiBaseUrl: baseUrl,
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      embeddingModel,
    });
  });

  describe.each(['openai', 'openrouter', 'openai-codex'])('%s model list validation', (provider) => {
    it.each(['', ' ', ', ,'])('rejects an explicitly empty model list %j', (models) => {
      expect(() => loadConfig({ LLM_PROVIDER: provider, LLM_MODELS: models })).toThrowError(/LLM_MODELS/);
    });
  });

  it.each(['not-a-url', '/backend-api/codex', 'https://'])('rejects invalid Codex base URL %j', (baseUrl) => {
    expect(() => loadConfig({ LLM_PROVIDER: 'openai-codex', CODEX_BASE_URL: baseUrl })).toThrowError(/CODEX_BASE_URL/);
  });

  it.each(['', 'OPENAI', ' openrouter ', 'unsupported'])('rejects invalid provider %j', (provider) => {
    expect(() => loadConfig({ LLM_PROVIDER: provider })).toThrowError(/LLM_PROVIDER/);
  });
});

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
