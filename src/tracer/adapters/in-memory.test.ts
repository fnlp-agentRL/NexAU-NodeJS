import { describe, expect, it } from "vitest";

import { InMemoryTracer } from "./in-memory.js";

describe("InMemoryTracer", () => {
  it("records run, events, and final result", () => {
    const tracer = new InMemoryTracer();

    const run = {
      runId: "run-memory",
      agentName: "agent-memory",
      input: "hello",
      recursionDepth: 0,
      userId: "u1",
      sessionId: "s1",
    };

    tracer.startRun(run);
    tracer.onEvent(run, {
      type: "run.started",
      payload: {
        iteration: 1,
      },
    });
    tracer.onEvent(run, {
      type: "run.completed",
      payload: {
        status: "completed",
      },
    });
    tracer.endRun({
      ...run,
      result: {
        status: "completed",
        output: "done",
        iterations: 1,
        messages: [],
        events: [],
      },
    });

    const stored = tracer.getRun("run-memory");
    expect(stored).toBeDefined();
    expect(stored?.run.agentName).toBe("agent-memory");
    expect(stored?.events.map((event) => event.type)).toEqual(["run.started", "run.completed"]);
    expect(stored?.result?.status).toBe("completed");
  });
});
