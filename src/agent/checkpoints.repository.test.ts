import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type Db } from '../db/index.js';
import type { AgentCheckpoint } from './agent.types.js';
import { AgentCheckpointsRepository } from './checkpoints.repository.js';

const messageOwner = 'message:007pSo2b8iXeAjheKEVRdv';
const jobOwner = 'job:007pSo2b8iXeAjheKEVRdv';
const checkpoint: AgentCheckpoint = {
  input: [
    { role: 'user', content: '근거를 찾아 줘 🐈' },
    { type: 'function_call', call_id: 'read-1', name: 'read_note', arguments: '{"path":"wiki/한글.md"}' },
    { type: 'function_call_output', call_id: 'read-1', output: '확인한 근거\n두 번째 줄' },
  ],
  text: '부분 답변',
  toolCalls: 1,
  usage: { inputTokens: 120, outputTokens: 30, reasoningTokens: 10 },
};
let directory: string;
let db: Db;
let repository: AgentCheckpointsRepository;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agent-checkpoints-'));
  db = openDb(join(directory, 'state.sqlite'));
  runMigrations(db);
  repository = new AgentCheckpointsRepository(db);
});

afterEach(() => {
  db?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('AgentCheckpointsRepository', () => {
  it('persists full tool-turn state across reopening under opaque prefixed owners', () => {
    expect(repository.get(messageOwner)).toBeUndefined();
    repository.save(messageOwner, checkpoint);
    repository.save(jobOwner, { input: [], text: '별도 작업', toolCalls: 0 });
    db.close();
    db = openDb(join(directory, 'state.sqlite'));
    repository = new AgentCheckpointsRepository(db);

    expect(repository.get(messageOwner)).toEqual(checkpoint);
    expect(repository.get(jobOwner)).toEqual({ input: [], text: '별도 작업', toolCalls: 0 });
    expect(db.prepare('SELECT owner FROM agent_checkpoints ORDER BY owner').all()).toEqual([
      { owner: jobOwner }, { owner: messageOwner },
    ]);

    const resumed: AgentCheckpoint = { input: checkpoint.input, text: '이어서 쓴 답변', toolCalls: 2 };
    repository.save(messageOwner, resumed);
    expect(repository.get(messageOwner)).toEqual(resumed);
    repository.delete(messageOwner);
    repository.delete(messageOwner);
    expect(repository.get(messageOwner)).toBeUndefined();
    expect(repository.get(jobOwner)).toEqual({ input: [], text: '별도 작업', toolCalls: 0 });
  });

  it('copies a snapshot independently and leaves the target unchanged when the source is absent', () => {
    repository.save(messageOwner, checkpoint);
    repository.save(jobOwner, { input: [], text: '기존 작업', toolCalls: 0 });
    expect(repository.copy(messageOwner, jobOwner)).toBe(true);
    expect(repository.get(jobOwner)).toEqual(checkpoint);

    const read = repository.get(jobOwner)!;
    read.text = '메모리에서만 바꿈';
    read.input.push({ role: 'user', content: '추가 입력' });
    expect(repository.get(jobOwner)).toEqual(checkpoint);
    expect(repository.copy('message:missing', jobOwner)).toBe(false);
    expect(repository.get(jobOwner)).toEqual(checkpoint);
    expect(repository.copy('job:missing', 'message:new')).toBe(false);
    expect(repository.get('message:new')).toBeUndefined();

    repository.save(messageOwner, { input: [], text: '새 상태', toolCalls: 3 });
    repository.delete(messageOwner);
    expect(repository.get(jobOwner)).toEqual(checkpoint);
    repository.delete(jobOwner);
    expect(repository.get(jobOwner)).toBeUndefined();
  });
});
