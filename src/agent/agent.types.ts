import type { ResponseInputContent } from 'openai/resources/responses/responses';
import type { User } from '../auth/users.types.js';

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

export type ChatMessage = { role: 'user' | 'assistant'; content: string | ResponseInputContent[] };
export type AgentEventHandler = (event: 'tool' | 'citation' | 'usage' | 'status', data: unknown) => void;

export interface AnswerOptions {
  /** Omitted only for trusted internal system callers. */
  user?: Pick<User, 'id' | 'role'>;
  /** Capability supplied by the chat caller after request authorization; absent for read-only requests. */
  submitKnowledge?: (content: string) => Promise<{ jobId: string; status: 'queued' }>;
  onSource?: (path: string) => void;
  assertAccess?: () => void;
  model?: string;
  effort?: string;
  context?: { notePath: string; ref?: string; selection?: string };
  summary?: string;
  onEvent?: AgentEventHandler;
}

export interface AgentTool<Result = string> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: unknown): Promise<Result>;
  /** Public progress must describe the operation, never expose tool output. */
  summary?(args: unknown): { summary: string; path?: string };
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
}
