import OpenAI from 'openai';
import type { Response, ResponseFunctionToolCall, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startFakeOpenAI, type FakeOpenAI } from './fake-openai.js';

const servers: FakeOpenAI[] = [];
const readNoteArguments = z.object({ path: z.string() });

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setup(script?: Parameters<typeof startFakeOpenAI>[0]) {
  const server = await startFakeOpenAI(script);
  servers.push(server);
  const client = new OpenAI({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 });
  return { server, client };
}

describe('fake OpenAI SDK compatibility', () => {
  it('returns repeatable unit embeddings with requested dimensions and stable batch ordering', async () => {
    const { server, client } = await setup();
    const batch = await client.embeddings.create({
      model: 'text-embedding-3-small', input: ['지식 저장소', '다른 문서', '지식 저장소'], dimensions: 32,
    });
    const repeated = await client.embeddings.create({
      model: 'text-embedding-3-small', input: '지식 저장소', dimensions: 32, encoding_format: 'float',
    });
    const defaults = await client.embeddings.create({ model: 'text-embedding-3-small', input: '지식 저장소' });

    expect(batch.data.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(batch.data[0]!.embedding).toEqual(batch.data[2]!.embedding);
    expect(batch.data[0]!.embedding).toEqual(repeated.data[0]!.embedding);
    expect(batch.data[0]!.embedding).not.toEqual(batch.data[1]!.embedding);
    for (const entry of batch.data) {
      expect(entry.embedding).toHaveLength(32);
      expect(Math.hypot(...entry.embedding)).toBeCloseTo(1, 6);
      expect(entry.embedding.every(Number.isFinite)).toBe(true);
    }
    expect(defaults.data[0]!.embedding).toHaveLength(1536);
    expect(Math.hypot(...defaults.data[0]!.embedding)).toBeCloseTo(1, 6);
    expect(server.requests[0]).toMatchObject({
      method: 'POST', path: '/v1/embeddings', body: { input: ['지식 저장소', '다른 문서', '지식 저장소'], dimensions: 32 },
    });
  });

  it('round-trips nonstream function calls and records the actual tool result', async () => {
    const { server, client } = await setup([
      { type: 'function_call', name: 'read_note', arguments: { path: 'wiki/engine.md' }, call_id: 'call_read_note' },
      '엔진은 지식 저장소를 관리한다.',
    ]);
    const tools = [{ type: 'function' as const, name: 'read_note', description: 'Read a note',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, strict: true }];
    const initial = await client.responses.create({ model: 'gpt-6-luna', input: '엔진이 무엇인가?', tools });
    const call = initial.output.find((item): item is ResponseFunctionToolCall => item.type === 'function_call')!;
    expect(call).toMatchObject({ name: 'read_note', call_id: 'call_read_note', status: 'completed' });
    expect(JSON.parse(call.arguments)).toEqual({ path: 'wiki/engine.md' });
    const notes: Record<string, string> = { 'wiki/engine.md': '# 엔진\n지식 저장소를 관리한다.' };
    const output = notes[readNoteArguments.parse(JSON.parse(call.arguments)).path]!;
    const final = await client.responses.create({
      model: 'gpt-6-luna', previous_response_id: initial.id, tools,
      input: [{ type: 'function_call_output', call_id: call.call_id, output }],
    });

    expect(initial.output_text).toBe('');
    expect(final.output_text).toBe('엔진은 지식 저장소를 관리한다.');
    expect(final.output[0]).toMatchObject({ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: '엔진은 지식 저장소를 관리한다.', annotations: [] }] });
    expect(server.requests[1]!.body).toMatchObject({
      previous_response_id: initial.id,
      input: [{ type: 'function_call_output', call_id: 'call_read_note', output: '# 엔진\n지식 저장소를 관리한다.' }],
    });
  });

  it.each(['events', 'helper'] as const)('round-trips parallel streaming tools through SDK %s and preserves mixed output ordering', async (mode) => {
    const { server, client } = await setup([
      { output: [
        '두 노트를 읽는다.',
        { name: 'read_note', arguments: '{"path":"wiki/engine.md"}', call_id: 'call_engine' },
        { name: 'read_note', arguments: { path: 'wiki/luna.md' }, call_id: 'call_luna' },
      ] },
      { text: '엔진은 지식을 관리하고 Luna는 답변한다. 🌙' },
    ]);
    const tools = [{ type: 'function' as const, name: 'read_note',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, strict: true }];
    const stream = mode === 'helper'
      ? client.responses.stream({ model: 'gpt-6-luna', input: '엔진과 Luna를 설명하라.', tools })
      : await client.responses.create({ model: 'gpt-6-luna', input: '엔진과 Luna를 설명하라.', tools, stream: true });
    const events: ResponseStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const initial = events.find((event) => event.type === 'response.completed')!.response;
    const calls = initial.output.filter((item): item is ResponseFunctionToolCall => item.type === 'function_call');
    expect(initial.output.map((item) => item.type)).toEqual(['message', 'function_call', 'function_call']);
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''))
      .toBe('두 노트를 읽는다.');
    expect(events.filter((event) => event.type === 'response.function_call_arguments.delta')
      .filter((event) => event.output_index === 1).map((event) => event.delta).join('')).toBe('{"path":"wiki/engine.md"}');
    expect(events.filter((event) => event.type === 'response.function_call_arguments.delta')
      .filter((event) => event.output_index === 2).map((event) => event.delta).join('')).toBe('{"path":"wiki/luna.md"}');
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item))
      .toEqual(initial.output);
    if ('finalResponse' in stream) {
      const parsed = await stream.finalResponse();
      expect(parsed.output).toMatchObject(initial.output);
      expect(parsed.output.filter((item) => item.type === 'function_call').map((item) => item.parsed_arguments))
        .toEqual([{ path: 'wiki/engine.md' }, { path: 'wiki/luna.md' }]);
    }
    const notes: Record<string, string> = { 'wiki/engine.md': '엔진은 지식을 관리한다.', 'wiki/luna.md': 'Luna는 답변한다.' };
    const input = calls.map((call) => ({
      type: 'function_call_output' as const, call_id: call.call_id,
      output: notes[readNoteArguments.parse(JSON.parse(call.arguments)).path]!,
    }));
    const answerStream = client.responses.stream({ model: 'gpt-6-luna', tools, previous_response_id: initial.id, input });
    let answer = '';
    const snapshots: string[] = [];
    answerStream.on('response.output_text.delta', (event) => { snapshots.push(event.snapshot); });
    for await (const event of answerStream) if (event.type === 'response.output_text.delta') answer += event.delta;
    const final: Response = await answerStream.finalResponse();

    expect(answer).toBe('엔진은 지식을 관리하고 Luna는 답변한다. 🌙');
    expect(final.output_text).toBe(answer);
    expect(final.status).toBe('completed');
    expect(snapshots.at(-1)).toBe(answer);
    expect(server.requests[1]!.body).toMatchObject({
      stream: true, previous_response_id: initial.id,
      input: [
        { type: 'function_call_output', call_id: 'call_engine', output: '엔진은 지식을 관리한다.' },
        { type: 'function_call_output', call_id: 'call_luna', output: 'Luna는 답변한다.' },
      ],
    });
  });

  it('keeps each server script isolated and reports exhausted turns rather than inventing output', async () => {
    const first = await setup(['첫 번째']);
    const second = await setup([{ functionCalls: [{ name: 'search', arguments: { query: '엔진' } }] }, '두 번째']);
    expect((await first.client.responses.create({ model: 'gpt-6-luna', input: 'first' })).output_text).toBe('첫 번째');
    const call = (await second.client.responses.create({ model: 'gpt-6-luna', input: 'second' })).output[0]!;
    expect(call).toMatchObject({ type: 'function_call', name: 'search', call_id: 'call_fake_1_0' });
    await second.client.embeddings.create({ model: 'text-embedding-3-small', input: 'interleaved' });
    expect((await second.client.responses.create({ model: 'gpt-6-luna', input: 'third' })).output_text).toBe('두 번째');
    await expect(first.client.responses.create({ model: 'gpt-6-luna', input: 'unexpected' })).rejects
      .toMatchObject({ status: 400, code: 'fake_script_exhausted' });
  });
});
