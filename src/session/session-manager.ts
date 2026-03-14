import type { ChatMessage } from "../core/execution/types.js";

export interface SessionState {
  history: ChatMessage[];
  agentState: Record<string, unknown>;
}

export interface SessionManager {
  get(userId: string, sessionId: string, agentId: string): Promise<SessionState>;
  set(userId: string, sessionId: string, agentId: string, state: SessionState): Promise<void>;
  delete(userId: string, sessionId: string, agentId: string): Promise<number>;
}

function key(userId: string, sessionId: string, agentId: string): string {
  return `${userId}::${sessionId}::${agentId}`;
}

export class InMemorySessionManager implements SessionManager {
  private readonly store = new Map<string, SessionState>();

  public async get(userId: string, sessionId: string, agentId: string): Promise<SessionState> {
    const k = key(userId, sessionId, agentId);
    const existing = this.store.get(k);
    if (existing) {
      return existing;
    }

    const created: SessionState = {
      history: [],
      agentState: {},
    };
    this.store.set(k, created);
    return created;
  }

  public async set(
    userId: string,
    sessionId: string,
    agentId: string,
    state: SessionState,
  ): Promise<void> {
    this.store.set(key(userId, sessionId, agentId), state);
  }

  public async delete(userId: string, sessionId: string, agentId: string): Promise<number> {
    return this.store.delete(key(userId, sessionId, agentId)) ? 1 : 0;
  }
}
