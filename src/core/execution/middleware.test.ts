import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../agent-config.js";
import {
  createLoggingMiddleware,
  resolveExecutionMiddlewares,
  runExecutionMiddlewarePipeline,
  type ExecutionMiddleware,
  type ExecutionMiddlewareContext,
} from "./middleware.js";

function createContext(agentState: Record<string, unknown> = {}): ExecutionMiddlewareContext {
  return {
    agent: {
      name: "middleware-agent",
    } as AgentConfig,
    input: "hello middleware",
    history: [],
    agentState,
    recursionDepth: 0,
  };
}

describe("execution middleware", () => {
  it("records before and after logs through logging middleware", async () => {
    const context = createContext({});
    const middleware = createLoggingMiddleware({ state_key: "logs" });

    const result = await runExecutionMiddlewarePipeline([middleware], context, async () => ({
      status: "completed",
      output: "ok",
      iterations: 1,
      messages: [],
      events: [],
    }));

    expect(result.status).toBe("completed");
    expect(Array.isArray(context.agentState.logs)).toBe(true);
    expect((context.agentState.logs as unknown[]).length).toBe(2);
  });

  it("resolves known middleware and keeps unknown middleware pass-through", async () => {
    const resolved = resolveExecutionMiddlewares([
      { import: "nexau.archs.main_sub.execution.hooks:LoggingMiddleware" },
      { import: "custom.middleware:UnknownMiddleware" },
    ]);

    expect(resolved.length).toBe(2);

    const context = createContext({});
    const result = await runExecutionMiddlewarePipeline(resolved, context, async () => ({
      status: "completed",
      output: "ok",
      iterations: 1,
      messages: [],
      events: [],
    }));

    expect(result.status).toBe("completed");
    expect(Array.isArray(context.agentState.middleware_logs)).toBe(true);
  });

  it("runs middleware in nested order (outermost first)", async () => {
    const order: string[] = [];
    const context = createContext({});

    const m1: ExecutionMiddleware = async (ctx, next) => {
      order.push("m1-before");
      const result = await next(ctx);
      order.push("m1-after");
      return result;
    };
    const m2: ExecutionMiddleware = async (ctx, next) => {
      order.push("m2-before");
      const result = await next(ctx);
      order.push("m2-after");
      return result;
    };

    const result = await runExecutionMiddlewarePipeline([m1, m2], context, async () => {
      order.push("core");
      return {
        status: "completed",
        output: "ok",
        iterations: 1,
        messages: [],
        events: [],
      };
    });

    expect(result.status).toBe("completed");
    expect(order).toEqual(["m1-before", "m2-before", "core", "m2-after", "m1-after"]);
  });
});
