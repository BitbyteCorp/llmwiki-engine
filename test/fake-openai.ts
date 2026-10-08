import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type {
  Response,
  ResponseCompactionItem,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { z } from 'zod';

export interface FakeFunctionCall {
  type?: 'function_call';
  name: string;
  arguments: string | Record<string, unknown>;
  call_id?: string;
}

export type FakeOutputItem = string | FakeFunctionCall | ResponseCompactionItem;
export type FakeTurn =
  | FakeOutputItem
  | ({ text: string }
  | { output: readonly FakeOutputItem[] }
  | { functionCalls: readonly FakeFunctionCall[]; text?: string }) & {
    usage?: { inputTokens: number; outputTokens: number; reasoningTokens: number };
  };
export type FakeScript = readonly FakeTurn[];

export interface FakeOpenAIRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export type FakeResponder = (request: FakeOpenAIRequest, index: number) => FakeTurn | Promise<FakeTurn>;

export interface FakeOpenAI {
  /** OpenAI client baseURL, including /v1. */
  url: string;
  close(): Promise<void>;
  requests: FakeOpenAIRequest[];
}

type FakeWireItem = ResponseOutputMessage | (ResponseFunctionToolCall & { id: string }) | ResponseCompactionItem;

const responseParameters = z.object({
  model: z.string().default('gpt-6-luna'),
  instructions: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  parallel_tool_calls: z.boolean().optional(),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  previous_response_id: z.string().nullish(),
  tools: z.array(z.object({
    type: z.literal('function'),
    name: z.string(),
    parameters: z.record(z.string(), z.unknown()).nullable().default(null),
    strict: z.boolean().nullable().default(null),
    description: z.string().nullable().default(null),
  })).default([]),
});

function embedding(input: string | number[], dimensions: number): number[] {
  let seed = createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input)).digest().readUInt32LE(0) || 1;
  const vector = new Array<number>(dimensions);
  let magnitude = 0;
  for (let index = 0; index < dimensions; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const value = (seed >>> 0) / 0x1_0000_0000 * 2 - 1;
    vector[index] = value;
    magnitude += value * value;
  }
  const norm = Math.sqrt(magnitude);
  for (let index = 0; index < dimensions; index++) vector[index] = Math.fround(vector[index]! / norm);
  return vector;
}

function encodeEmbedding(vector: number[]): string {
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index++) bytes.writeFloatLE(vector[index]!, index * 4);
  return bytes.toString('base64');
}

function turnItems(turn: FakeTurn): readonly FakeOutputItem[] {
  if (typeof turn === 'string') return [turn];
  if ('output' in turn) return turn.output;
  if ('functionCalls' in turn) return turn.text === undefined ? turn.functionCalls : [turn.text, ...turn.functionCalls];
  if ('text' in turn) return [turn.text];
  return [turn];
}

function makeResponse(turn: FakeTurn, number: number, params: z.infer<typeof responseParameters>): Response {
  const output: FakeWireItem[] = turnItems(turn).map((item, index) => {
    if (typeof item === 'string') {
      return {
        id: `msg_fake_${number}_${index}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: item, annotations: [], logprobs: [] }],
      };
    }
    if (item.type === 'compaction') return item;
    return {
      id: `fc_fake_${number}_${index}`, type: 'function_call', status: 'completed',
      name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
      call_id: item.call_id ?? `call_fake_${number}_${index}`,
    };
  });
  const usage = typeof turn !== 'string' && 'usage' in turn ? turn.usage : undefined;
  return {
    id: `resp_fake_${number}`, object: 'response', created_at: 0, completed_at: 0,
    status: 'completed', access_programs: null, error: null, incomplete_details: null,
    instructions: params.instructions ?? null, metadata: params.metadata ?? {}, model: params.model ?? 'gpt-6-luna',
    output, output_text: output.flatMap((item) => item.type === 'message'
      ? item.content.flatMap((part) => part.type === 'output_text' ? [part.text] : []) : []).join(''),
    parallel_tool_calls: params.parallel_tool_calls ?? true, temperature: params.temperature ?? 1,
    tool_choice: 'auto', tools: params.tools, top_p: params.top_p ?? 1,
    previous_response_id: params.previous_response_id ?? null, reasoning: null,
    text: { format: { type: 'text' } }, truncation: 'disabled',
    usage: { input_tokens: usage?.inputTokens ?? 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: usage?.outputTokens ?? 0, output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 },
      total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) },
  };
}

function streamResponse(res: ServerResponse, response: Response): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let sequence = 0;
  const emit = (event: ResponseStreamEvent) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const initial: Response = { ...response, status: 'in_progress', completed_at: null, output: [], output_text: '' };
  delete initial.usage;
  emit({ type: 'response.created', response: initial, sequence_number: sequence++ });
  emit({ type: 'response.in_progress', response: initial, sequence_number: sequence++ });
  response.output.forEach((item, output_index) => {
    if (item.type !== 'message' && item.type !== 'function_call') return;
    const item_id = item.id!;
    emit({ type: 'response.output_item.added', output_index, sequence_number: sequence++, item:
      item.type === 'message' ? { ...item, status: 'in_progress', content: [] }
        : { ...item, status: 'in_progress', arguments: '' } });
    if (item.type === 'function_call') {
      // Split deltas to exercise argument accumulation rather than only the terminal snapshot.
      const middle = Math.ceil(item.arguments.length / 2);
      for (const delta of [item.arguments.slice(0, middle), item.arguments.slice(middle)]) {
        if (delta) emit({ type: 'response.function_call_arguments.delta', item_id, output_index, delta, sequence_number: sequence++ });
      }
      emit({ type: 'response.function_call_arguments.done', item_id, output_index, arguments: item.arguments, sequence_number: sequence++ });
    } else {
      item.content.forEach((part, content_index) => {
        if (part.type !== 'output_text') return;
        emit({ type: 'response.content_part.added', item_id, output_index, content_index,
          part: { ...part, text: '' }, sequence_number: sequence++ });
        const middle = Math.ceil(part.text.length / 2);
        for (const delta of [part.text.slice(0, middle), part.text.slice(middle)]) {
          if (delta) emit({ type: 'response.output_text.delta', item_id, output_index, content_index,
            delta, logprobs: [], sequence_number: sequence++ });
        }
        emit({ type: 'response.output_text.done', item_id, output_index, content_index, text: part.text,
          logprobs: [], sequence_number: sequence++ });
        emit({ type: 'response.content_part.done', item_id, output_index, content_index, part, sequence_number: sequence++ });
      });
    }
    emit({ type: 'response.output_item.done', output_index, item, sequence_number: sequence++ });
  });
  emit({ type: 'response.completed', response, sequence_number: sequence++ });
  res.end();
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

export async function startFakeOpenAI(script: FakeScript | FakeResponder = []): Promise<FakeOpenAI> {
  const requests: FakeOpenAIRequest[] = [];
  let nextTurn = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      const request: FakeOpenAIRequest = { method: req.method ?? '', path: req.url ?? '', body };
      requests.push(request);
      if (request.method === 'POST' && request.path === '/v1/embeddings') {
        const dimensions = request.body.dimensions ?? 1536;
        if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions < 1) {
          json(res, 400, { error: { type: 'invalid_request_error', message: 'dimensions must be a positive integer' } });
          return;
        }
        const input = request.body.input;
        let inputs: Array<string | number[]>;
        if (typeof input === 'string') inputs = [input];
        else if (Array.isArray(input) && input.every((value) => typeof value === 'number')) inputs = [input];
        else if (Array.isArray(input) && input.every((value) => typeof value === 'string'
          || Array.isArray(value) && value.every((token) => typeof token === 'number'))) inputs = input;
        else {
          json(res, 400, { error: { type: 'invalid_request_error', message: 'Unsupported embeddings input' } });
          return;
        }
        json(res, 200, {
          object: 'list', model: request.body.model ?? 'text-embedding-3-small',
          data: inputs.map((value, index) => {
            const vector = embedding(value, dimensions);
            return { object: 'embedding', index, embedding: request.body.encoding_format === 'base64' ? encodeEmbedding(vector) : vector };
          }), usage: { prompt_tokens: 0, total_tokens: 0 },
        });
        return;
      }
      if (request.method === 'POST' && request.path === '/v1/responses') {
        const params = responseParameters.parse(request.body);
        const index = nextTurn++;
        const turn = typeof script === 'function' ? await script(request, index) : script[index];
        if (turn === undefined) {
          json(res, 400, { error: { type: 'invalid_request_error', code: 'fake_script_exhausted', message: 'Fake OpenAI response script exhausted' } });
          return;
        }
        const response = makeResponse(turn, index + 1, params);
        if (request.body.stream === true) streamResponse(res, response);
        else json(res, 200, response);
        return;
      }
      json(res, 404, { error: { type: 'invalid_request_error', message: `Unknown fake OpenAI route: ${request.method} ${request.path}` } });
    } catch (error) {
      json(res, error instanceof SyntaxError || error instanceof z.ZodError ? 400 : 500, {
        error: { type: 'invalid_request_error', message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake OpenAI server did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/v1`, requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
