export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: unknown): Promise<string>;
}

export interface RunAgentOptions {
  instructions: string;
  input: string | Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: AgentTool[];
  effort?: string;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  maxTurns?: number;
}
