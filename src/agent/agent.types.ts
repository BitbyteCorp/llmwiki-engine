import type { ResponseInputContent, ResponseInputItem } from 'openai/resources/responses/responses';
import type { User } from '../auth/users.types.js';
import type { JobPhase, WriteJob } from '../jobs/write-job.types.js';

export interface Citation {
  path: string;
  heading?: string;
  anchor?: string;
  excerpt?: string;
  sha?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface AgentCheckpoint {
  input: ResponseInputItem[];
  text: string;
  toolCalls: number;
  usage?: TokenUsage;
}

export interface AnswerCheckpoint extends AgentCheckpoint {
  /** Verified full-note evidence survives model input compaction. */
  readNotes?: Array<{ path: string; content: string; sha: string }>;
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string | ResponseInputContent[] };
export type AgentEventHandler = (event: 'tool' | 'citation' | 'usage' | 'status', data: unknown) => void;

export interface ChatWriteSubagent {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  files: string[];
  toolCalls: number;
  result?: string;
  error?: string;
}

export interface ChatWriteStatus {
  jobId: string;
  status: WriteJob['status'];
  phase?: JobPhase;
  summary?: string | null;
  error?: string | null;
  mergeSha?: string | null;
  commits: string[];
  subagents?: ChatWriteSubagent[];
}

export interface AnswerOptions {
  /** Omitted only for trusted internal system callers. */
  user?: Pick<User, 'id' | 'role'>;
  /** Capability supplied by the chat caller after request authorization; absent for read-only requests. */
  submitKnowledge?: (content: string) => Promise<{ jobId: string; status: WriteJob['status']; reused?: boolean }>;
  getWriteStatus?: (jobId: string) => Promise<ChatWriteStatus>;
  waitWrite?: (jobId: string, timeoutSeconds: number, signal?: AbortSignal) => Promise<ChatWriteStatus & { timedOut: boolean }>;
  onSource?: (path: string) => void;
  assertAccess?: () => void;
  model?: string;
  effort?: string;
  context?: { notePath: string; ref?: string; selection?: string };
  summary?: string;
  onEvent?: AgentEventHandler;
  resume?: AnswerCheckpoint;
  onCheckpoint?: (checkpoint: AnswerCheckpoint) => void;
}

export interface AgentTool<Result = string> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Read-only network work observes cancellation; started filesystem mutations must finish. */
  run(args: unknown, signal?: AbortSignal): Promise<Result>;
  /** Public progress must describe the operation, never expose tool output. */
  summary?(args: unknown): { summary: string; path?: string; jobId?: string };
}

export interface RunAgentOptions {
  instructions: string;
  input: string | ChatMessage[];
  tools: AgentTool<string | { output: string; jobId: string }>[];
  effort?: string;
  model?: string;
  onEvent?: AgentEventHandler;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  maxTurns?: number;
  assertAccess?: () => void;
  /** Resume at a completed tool-turn boundary; input is ignored and maxTurns restarts. */
  resume?: AgentCheckpoint;
  /** Receives an independent JSON-serializable snapshot after each tool turn. */
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void;
  /** Drain queued messages before each model turn. */
  beforeTurn?: () => ChatMessage[];
  onToolCall?: (count: number) => void;
}
