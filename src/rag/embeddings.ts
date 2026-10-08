import { createOpenAI } from '../common/openai.js';
import type { Config } from '../config.js';

// 128 chunks of approximately 800 tokens stay below the aggregate API input limit.
const BATCH_SIZE = 128;

export async function embedTexts(config: Config, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  signal?.throwIfAborted();
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is required for embeddings');
  const client = createOpenAI(config);
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    signal?.throwIfAborted();
    const batch = texts.slice(offset, offset + BATCH_SIZE);
    const response = await client.embeddings.create({
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
      input: batch,
      encoding_format: 'float',
    }, { signal });
    signal?.throwIfAborted();
    const ordered = response.data.toSorted((a, b) => a.index - b.index);
    if (ordered.length !== batch.length) throw new Error('Embedding API returned an incomplete batch');
    for (let index = 0; index < ordered.length; index++) {
      const item = ordered[index];
      if (item.index !== index || item.embedding.length !== config.embeddingDimensions
        || item.embedding.some((value) => !Number.isFinite(value))) {
        throw new Error('Embedding API returned an invalid vector or dimension');
      }
      vectors.push(item.embedding);
    }
  }
  return vectors;
}
