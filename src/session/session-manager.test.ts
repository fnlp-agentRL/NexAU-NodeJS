import { describe, expect, it } from "vitest";

import { InMemorySessionManager } from "./session-manager.js";

describe("InMemorySessionManager", () => {
  it("isolates state by user/session/agent key", async () => {
    const manager = new InMemorySessionManager();

    await manager.set("u", "s", "agent-a", {
      history: [{ role: "user", content: "A1" }],
      agentState: { owner: "a" },
    });
    await manager.set("u", "s", "agent-b", {
      history: [{ role: "user", content: "B1" }],
      agentState: { owner: "b" },
    });

    const aState = await manager.get("u", "s", "agent-a");
    const bState = await manager.get("u", "s", "agent-b");

    expect(aState.history[0]?.content).toBe("A1");
    expect(bState.history[0]?.content).toBe("B1");
    expect(aState.agentState.owner).toBe("a");
    expect(bState.agentState.owner).toBe("b");
  });

  it("deletes state by user/session/agent key", async () => {
    const manager = new InMemorySessionManager();

    await manager.set("u", "s", "agent-a", {
      history: [{ role: "user", content: "A1" }],
      agentState: { owner: "a" },
    });
    await manager.set("u", "s", "agent-b", {
      history: [{ role: "user", content: "B1" }],
      agentState: { owner: "b" },
    });

    const deletedA = await manager.delete("u", "s", "agent-a");
    expect(deletedA).toBe(1);

    const aState = await manager.get("u", "s", "agent-a");
    const bState = await manager.get("u", "s", "agent-b");

    expect(aState).toEqual({
      history: [],
      agentState: {},
    });
    expect(bState.history[0]?.content).toBe("B1");
  });
});
