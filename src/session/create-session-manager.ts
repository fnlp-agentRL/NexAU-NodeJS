import { InMemorySessionManager, type SessionManager } from "./session-manager.js";
import { SqliteSessionManager } from "./sqlite-session-manager.js";

export function createSessionManager(sessionDbPath?: string): SessionManager {
  if (!sessionDbPath) {
    return new InMemorySessionManager();
  }
  return new SqliteSessionManager(sessionDbPath);
}
