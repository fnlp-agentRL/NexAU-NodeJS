import { beforeEach, describe, expect, it, vi } from "vitest";

import { LangfuseTracer } from "./langfuse.js";

describe("LangfuseTracer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts ingestion payload on run end", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      async text() {
        return "";
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tracer = new LangfuseTracer({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "https://langfuse.example",
    });

    const run = {
      runId: "run-1",
      agentName: "agent-a",
      input: "hello",
      recursionDepth: 0,
      userId: "user-1",
      sessionId: "session-1",
      metadata: { source: "test" },
      tags: ["compat"],
    };

    tracer.startRun(run);
    tracer.onEvent(run, {
      type: "run.started",
      payload: { iteration: 1 },
    });
    await tracer.endRun({
      ...run,
      result: {
        status: "completed",
        output: "ok",
        iterations: 1,
        messages: [],
        events: [],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined;
    if (!firstCall) {
      throw new Error("expected fetch to be called");
    }
    const url = firstCall[0];
    const init = firstCall[1];
    expect(url).toBe("https://langfuse.example/api/public/ingestion");
    const headers =
      init && typeof init === "object" && "headers" in init
        ? (init as { headers?: Record<string, string> }).headers
        : undefined;
    expect(headers?.authorization).toBe("Basic cGstdGVzdDpzay10ZXN0");
    expect(headers?.["content-type"]).toBe("application/json");
    const bodyRaw =
      init && typeof init === "object" && "body" in init
        ? (init as Record<string, unknown>).body
        : undefined;
    const body = typeof bodyRaw === "string" ? JSON.parse(bodyRaw) : null;
    expect(body?.batch?.[0]?.type).toBe("trace-create");
    expect(body?.batch?.[0]?.body?.id).toBe("run-1");
    expect(body?.batch?.[0]?.body?.name).toBe("agent-a");
    expect(body?.batch?.[0]?.body?.input).toBe("hello");
    expect(body?.batch?.[0]?.body?.output).toBe("ok");
    expect(body?.batch?.[0]?.body?.userId).toBe("user-1");
    expect(body?.batch?.[0]?.body?.sessionId).toBe("session-1");
    expect(body?.batch?.[0]?.body?.metadata?.recursionDepth).toBe(0);
    expect(body?.batch?.[0]?.body?.metadata?.status).toBe("completed");
    expect(body?.batch?.[0]?.body?.metadata?.iterations).toBe(1);
    expect(body?.batch?.[0]?.body?.metadata?.events?.[0]?.type).toBe("run.started");
    expect(body?.batch?.[0]?.body?.metadata?.events?.[0]?.payload).toEqual({ iteration: 1 });
  });

  it("no-ops when credentials are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tracer = new LangfuseTracer({
      enabled: true,
      host: "https://langfuse.example",
      publicKey: "",
      secretKey: "",
    });

    const run = {
      runId: "run-2",
      agentName: "agent-b",
      input: "hello",
      recursionDepth: 0,
    };
    tracer.startRun(run);
    await tracer.endRun({
      ...run,
      result: {
        status: "completed",
        output: "ok",
        iterations: 1,
        messages: [],
        events: [],
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
