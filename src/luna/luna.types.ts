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
export type LunaEventHandler = (event: 'tool' | 'citation' | 'usage' | 'status', data: unknown) => void;

export interface AnswerOptions {
  /** Omitted only for trusted internal system callers. */
  user?: Pick<User, 'id' | 'role'>;
  onSource?: (path: string) => void;
  assertAccess?: () => void;
  model?: string;
  effort?: string;
  context?: { notePath: string; ref?: string; selection?: string };
  summary?: string;
  onEvent?: LunaEventHandler;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: unknown): Promise<string>;
  /** Public progress must describe the operation, never expose tool output. */
  summary?(args: unknown): { summary: string; path?: string };
}

export interface RunAgentOptions {
  instructions: string;
  input: string | ChatMessage[];
  tools: AgentTool[];
  effort?: string;
  model?: string;
  onEvent?: LunaEventHandler;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  maxTurns?: number;
  assertAccess?: () => void;
}
