import type { SubagentSnapshot } from '../agent/subagents.js';

export type ProjectedSubagent = Omit<SubagentSnapshot, 'startedAt'> & { startedAt?: string };

/** Claims are display metadata, not evidence that a source was accessed. */
export function projectSubagent(value: unknown, canRead: (path: string) => boolean, restricted = false): ProjectedSubagent | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.id !== 'string' || typeof snapshot.name !== 'string'
    || !['running', 'completed', 'failed', 'cancelled'].includes(String(snapshot.status))
    || !Array.isArray(snapshot.files) || typeof snapshot.toolCalls !== 'number') return null;
  const files = snapshot.files.filter((path): path is string => typeof path === 'string');
  const visibleFiles = files.filter(canRead);
  const hidden = restricted || visibleFiles.length !== files.length;
  return {
    id: snapshot.id, name: snapshot.name, status: snapshot.status as SubagentSnapshot['status'],
    files: visibleFiles, toolCalls: snapshot.toolCalls,
    ...(typeof snapshot.startedAt === 'string' ? { startedAt: snapshot.startedAt } : {}),
    ...(typeof snapshot.finishedAt === 'string' ? { finishedAt: snapshot.finishedAt } : {}),
    ...(!hidden && typeof snapshot.result === 'string' ? { result: snapshot.result } : {}),
    ...(!hidden && typeof snapshot.error === 'string' ? { error: snapshot.error } : {}),
  };
}
