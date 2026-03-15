import type { AgentConfig } from "../agent-config.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
}

export interface LLMCompleteInput {
  agent: AgentConfig;
  messages: ChatMessage[];
  tools: Array<Record<string, unknown>>;
}

export interface LLMClient {
  complete(input: LLMCompleteInput): Promise<LLMResponse>;
}

export interface ExecuteOptions {
  agent: AgentConfig;
  input: string;
  history?: ChatMessage[];
  agentState?: Record<string, unknown>;
  recursionDepth?: number;
  signal?: AbortSignal;
  traceContext?: {
    userId?: string;
    sessionId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  };
  onEvent?: (event: ExecutionEvent) => void;
}

export interface ExecutionEvent {
  type:
    | "run.started"
    | "context.compacted"
    | "llm.requested"
    | "llm.failover.triggered"
    | "llm.failover.attempted"
    | "llm.failover.succeeded"
    | "llm.failover.failed"
    | "tool.selection"
    | "llm.responded"
    | "tool.called"
    | "tool.completed"
    | "subagent.called"
    | "subagent.completed"
    | "run.completed"
    | "run.failed";
  payload: Record<string, unknown>;
}

export interface ExecutionResult {
  status: "completed" | "stopped_by_tool" | "max_iterations_exceeded" | "failed";
  output: string;
  iterations: number;
  messages: ChatMessage[];
  events: ExecutionEvent[];
  stop_tool_name?: string;
  last_tool_result?: Record<string, unknown>;
  error?: string;
}

export interface ExecutorDeps {
  createLLMClient: (agent: AgentConfig) => LLMClient;
}
