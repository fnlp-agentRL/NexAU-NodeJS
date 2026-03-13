import { describe, expect, it } from "vitest";

import type { ExecutionTracer } from "./base.js";
import { CompositeTracer } from "./composite.js";

describe("CompositeTracer", () => {
  it("fans out run lifecycle and ignores child tracer failures", async () => {
    const calls: string[] = [];

    const okTracer: ExecutionTracer = {
      startRun() {
        calls.push("ok:start");
      },
      onEvent() {
        calls.push("ok:event");
      },
      endRun() {
        calls.push("ok:end");
      },
      flush() {
        calls.push("ok:flush");
      },
      shutdown() {
        calls.push("ok:shutdown");
      },
    };

    const failTracer: ExecutionTracer = {
      startRun() {
        throw new Error("start failed");
      },
      onEvent() {
        throw new Error("event failed");
      },
      endRun() {
        throw new Error("end failed");
      },
      flush() {
        throw new Error("flush failed");
      },
      shutdown() {
        throw new Error("shutdown failed");
      },
    };

    const composite = new CompositeTracer([okTracer, failTracer]);
    const run = {
      runId: "run-composite",
      agentName: "agent",
      input: "hello",
      recursionDepth: 0,
    };

    await composite.startRun(run);
    await composite.onEvent(run, {
      type: "run.started",
      payload: {},
    });
    await composite.endRun({
      ...run,
      result: {
        status: "completed",
        output: "ok",
        iterations: 1,
        messages: [],
        events: [],
      },
    });
    await composite.flush();
    await composite.shutdown();

    expect(calls).toEqual(["ok:start", "ok:event", "ok:end", "ok:flush", "ok:shutdown"]);
  });
});
