import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { embedTexts } from '../../src/rag/embeddings.js';
import { startFakeOpenAI } from '../fake-openai.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const fake = await startFakeOpenAI([], { embeddingUsage: { promptTokens: 13, totalTokens: 17 } });
  cleanup.push(() => fake.close());
  const config = loadConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'fake', OPENAI_BASE_URL: fake.url,
    EMBEDDING_DIMENSIONS: '2' });
  return { fake, config };
}

describe('embedding usage', () => {
  it('accounts for each returned batch using total tokens rather than prompt tokens', async () => {
    const { fake, config } = await fixture();
    const usage: Array<{ model: string; inputTokens: number }> = [];
    const texts = Array.from({ length: 129 }, (_, index) => `text ${index}`);
    const vectors = await embedTexts(config, texts, undefined, (entry) => usage.push(entry));
    expect(vectors).toHaveLength(129);
    expect(fake.requests.map(({ body }) => (body.input as string[]).length)).toEqual([128, 1]);
    expect(usage).toEqual([
      { model: 'text-embedding-3-small', inputTokens: 17 },
      { model: 'text-embedding-3-small', inputTokens: 17 },
    ]);
  });

  it('accounts for a received response before aborting and does not request the next batch', async () => {
    const { fake, config } = await fixture();
    const controller = new AbortController();
    const reason = new Error('abort after response');
    const usage: Array<{ model: string; inputTokens: number }> = [];
    await expect(embedTexts(config, Array.from({ length: 129 }, () => 'text'), controller.signal, (entry) => {
      usage.push(entry);
      controller.abort(reason);
    })).rejects.toBe(reason);
    expect(usage).toEqual([{ model: 'text-embedding-3-small', inputTokens: 17 }]);
    expect(fake.requests).toHaveLength(1);
  });
});
