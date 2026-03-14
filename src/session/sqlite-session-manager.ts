import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { ChatMessage } from "../core/execution/types.js";
import type { SessionManager, SessionState } from "./session-manager.js";

interface SessionRow {
  history_json: string;
  agent_state_json: string;
}

const LEGACY_AGENT_ID = "default-agent";

function parseJsonOrDefault<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is ChatMessage => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const typed = item as Record<string, unknown>;
    return typeof typed.role === "string" && typeof typed.content === "string";
  });
}

function normalizeAgentState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export class SqliteSessionManager implements SessionManager {
  private readonly db: DatabaseSync;
  private lock: Promise<void> = Promise.resolve();

  public constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);

    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        history_json TEXT NOT NULL,
        agent_state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, session_id, agent_id)
      );
    `);

    this.migrateLegacySchemaIfNeeded();
  }

  private migrateLegacySchemaIfNeeded(): void {
    const pragma = this.db.prepare("PRAGMA table_info(sessions)");
    const columns = pragma.all() as Array<{ name?: string }>;
    const hasAgentId = columns.some((column) => column.name === "agent_id");
    if (hasAgentId) {
      return;
    }

    this.db.exec("ALTER TABLE sessions RENAME TO sessions_legacy;");
    this.db.exec(`
      CREATE TABLE sessions (
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        history_json TEXT NOT NULL,
        agent_state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, session_id, agent_id)
      );
    `);
    this.db.exec(`
      INSERT INTO sessions (user_id, session_id, agent_id, history_json, agent_state_json, updated_at)
      SELECT user_id, session_id, '${LEGACY_AGENT_ID}', history_json, agent_state_json, updated_at
      FROM sessions_legacy;
    `);
    this.db.exec("DROP TABLE sessions_legacy;");
  }

  private async withLock<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: (() => void) | undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release?.();
    }
  }

  public async get(userId: string, sessionId: string, agentId: string): Promise<SessionState> {
    return this.withLock(() => {
      const statement = this.db.prepare(
        "SELECT history_json, agent_state_json FROM sessions WHERE user_id = ? AND session_id = ? AND agent_id = ?",
      );
      const row = statement.get(userId, sessionId, agentId) as SessionRow | undefined;

      if (!row) {
        return {
          history: [],
          agentState: {},
        };
      }

      const history = normalizeHistory(parseJsonOrDefault<unknown>(row.history_json, []));
      const agentState = normalizeAgentState(parseJsonOrDefault<unknown>(row.agent_state_json, {}));

      return {
        history,
        agentState,
      };
    });
  }

  public async set(
    userId: string,
    sessionId: string,
    agentId: string,
    state: SessionState,
  ): Promise<void> {
    await this.withLock(() => {
      const statement = this.db.prepare(`
        INSERT INTO sessions (user_id, session_id, agent_id, history_json, agent_state_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, session_id, agent_id)
        DO UPDATE SET
          history_json = excluded.history_json,
          agent_state_json = excluded.agent_state_json,
          updated_at = excluded.updated_at
      `);

      statement.run(
        userId,
        sessionId,
        agentId,
        JSON.stringify(state.history),
        JSON.stringify(state.agentState),
        Date.now(),
      );
    });
  }

  public async delete(userId: string, sessionId: string, agentId: string): Promise<number> {
    return this.withLock(() => {
      const statement = this.db.prepare(
        "DELETE FROM sessions WHERE user_id = ? AND session_id = ? AND agent_id = ?",
      );
      const result = statement.run(userId, sessionId, agentId) as { changes?: number } | undefined;
      return typeof result?.changes === "number" ? result.changes : 0;
    });
  }

  public async close(): Promise<void> {
    await this.withLock(() => {
      this.db.close();
    });
  }
}
