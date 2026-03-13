import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteSessionManager } from "./sqlite-session-manager.js";

describe("SqliteSessionManager", () => {
  it("returns default state when session is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-sqlite-session-empty-"));
    const manager = new SqliteSessionManager(join(dir, "sessions.db"));

    const state = await manager.get("u1", "s1", "agent-a");
    expect(state).toEqual({
      history: [],
      agentState: {},
    });

    await manager.close();
  });

  it("persists and reloads session state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-sqlite-session-persist-"));
    const dbPath = join(dir, "sessions.db");

    const manager1 = new SqliteSessionManager(dbPath);
    await manager1.set("u1", "s1", "agent-a", {
      history: [{ role: "user", content: "hello" }],
      agentState: { todos: [{ description: "a", status: "pending" }] },
    });
    await manager1.close();

    const manager2 = new SqliteSessionManager(dbPath);
    const state = await manager2.get("u1", "s1", "agent-a");
    expect(state.history.length).toBe(1);
    expect((state.agentState.todos as unknown[]).length).toBe(1);
    await manager2.close();
  });

  it("handles concurrent writes without corruption", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-sqlite-session-concurrency-"));
    const manager = new SqliteSessionManager(join(dir, "sessions.db"));

    await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        await manager.set("u-concurrent", `s-${index}`, "agent-a", {
          history: [{ role: "user", content: `msg-${index}` }],
          agentState: { index },
        });
      }),
    );

    const reads = await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        const state = await manager.get("u-concurrent", `s-${index}`, "agent-a");
        return state.history[0]?.content;
      }),
    );

    expect(reads.filter((item) => typeof item === "string").length).toBe(40);

    await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        await manager.set("u-same", "s-shared", "agent-a", {
          history: [{ role: "user", content: `msg-${index}` }],
          agentState: { index },
        });
      }),
    );

    const finalState = await manager.get("u-same", "s-shared", "agent-a");
    expect(finalState.history.length).toBe(1);
    expect(typeof finalState.history[0]?.content).toBe("string");
    expect(typeof (finalState.agentState.index as unknown)).toBe("number");

    await manager.close();
  });

  it("isolates states by agent id under same user and session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-sqlite-session-agent-dim-"));
    const manager = new SqliteSessionManager(join(dir, "sessions.db"));

    await manager.set("u", "s", "agent-a", {
      history: [{ role: "user", content: "from-a" }],
      agentState: { owner: "a" },
    });
    await manager.set("u", "s", "agent-b", {
      history: [{ role: "user", content: "from-b" }],
      agentState: { owner: "b" },
    });

    const aState = await manager.get("u", "s", "agent-a");
    const bState = await manager.get("u", "s", "agent-b");

    expect(aState.history[0]?.content).toBe("from-a");
    expect(bState.history[0]?.content).toBe("from-b");
    expect(aState.agentState.owner).toBe("a");
    expect(bState.agentState.owner).toBe("b");

    await manager.close();
  });
});
