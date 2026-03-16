import { createHash } from "node:crypto";

import type { Agent } from "../core/agent.js";
import type { ChatMessage, ExecutionEvent, ExecutionResult } from "../core/execution/types.js";
import { InMemorySessionManager, type SessionManager } from "../session/session-manager.js";

export interface RuntimeRequest {
  input: string;
  user_id?: string;
  session_id?: string;
  history?: ChatMessage[];
  system_prompt_addition?: string;
  signal?: AbortSignal;
}

export interface RuntimeSessionIdentity {
  user_id?: string;
  session_id?: string;
}

export interface RuntimeResponse {
  status: ExecutionResult["status"];
  output: string;
  iterations: number;
  stop_tool_name?: string;
  events: ExecutionEvent[];
  messages: ChatMessage[];
}

function normalizePersistedHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role !== "system");
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    normalized[key] = normalizeForHash(record[key]);
  }
  return normalized;
}

function isEmptySessionState(session: {
  history: ChatMessage[];
  agentState: Record<string, unknown>;
}): boolean {
  return session.history.length === 0 && Object.keys(session.agentState).length === 0;
}

export class RuntimeService {
  private readonly agent: Agent;
  private readonly sessionManager: SessionManager;
  private readonly agentSessionId: string;

  public constructor(agent: Agent, sessionManager: SessionManager = new InMemorySessionManager()) {
    this.agent = agent;
    this.sessionManager = sessionManager;
    this.agentSessionId = this.buildAgentSessionId();
  }

  private buildAgentSessionId(): string {
    const configRecord = this.agent.config as unknown as {
      toSerializable?: () => Record<string, unknown>;
      name?: string;
    };
    const serializable =
      typeof configRecord.toSerializable === "function"
        ? configRecord.toSerializable()
        : { name: configRecord.name ?? "configured_agent" };
    const normalized = normalizeForHash(serializable);
    const digest = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex")
      .slice(0, 12);
    return `${this.agent.config.name}#${digest}`;
  }

  public async query(
    request: RuntimeRequest,
    onEvent?: (event: ExecutionEvent) => void,
  ): Promise<RuntimeResponse> {
    const userId = request.user_id ?? "default-user";
    const sessionId = request.session_id ?? "default-session";
    const agentId = this.agentSessionId;
    const legacyAgentId = this.agent.config.name;

    let session = await this.sessionManager.get(userId, sessionId, agentId);
    if (agentId !== legacyAgentId && isEmptySessionState(session)) {
      const legacySession = await this.sessionManager.get(userId, sessionId, legacyAgentId);
      if (!isEmptySessionState(legacySession)) {
        session = legacySession;
        await this.sessionManager.set(userId, sessionId, agentId, legacySession);
      }
    }
    const history = request.history ?? session.history;

    const result = await this.agent.run(request.input, {
      history,
      systemPromptAddition: request.system_prompt_addition,
      agentState: session.agentState,
      signal: request.signal,
      traceContext: {
        userId,
        sessionId,
      },
      onEvent,
    });

    const nextState = {
      history: normalizePersistedHistory(result.messages),
      agentState: session.agentState,
    };
    await this.sessionManager.set(userId, sessionId, agentId, nextState);

    return {
      status: result.status,
      output: result.output,
      iterations: result.iterations,
      stop_tool_name: result.stop_tool_name,
      events: result.events,
      messages: result.messages,
    };
  }

  public getInfo(): Record<string, unknown> {
    return {
      name: this.agent.config.name,
      agent_session_id: this.agentSessionId,
      max_iterations: this.agent.config.max_iterations,
      max_context_tokens: this.agent.config.max_context_tokens,
      tool_call_mode: this.agent.config.tool_call_mode,
      tool_count: this.agent.config.tools.length,
    };
  }

  public async clearSession(identity: RuntimeSessionIdentity): Promise<{
    user_id: string;
    session_id: string;
    cleared_rows: number;
    agent_session_id: string;
  }> {
    const userId = identity.user_id ?? "default-user";
    const sessionId = identity.session_id ?? "default-session";
    const agentIds = new Set([this.agentSessionId, this.agent.config.name]);

    let clearedRows = 0;
    for (const agentId of agentIds) {
      clearedRows += await this.sessionManager.delete(userId, sessionId, agentId);
    }

    return {
      user_id: userId,
      session_id: sessionId,
      cleared_rows: clearedRows,
      agent_session_id: this.agentSessionId,
    };
  }
}
