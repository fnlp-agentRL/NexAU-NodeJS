import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("records error log when wrapped execution throws", async () => {
    const context = createContext({});
    const middleware = createLoggingMiddleware({ state_key: "logs" });

    await expect(
      runExecutionMiddlewarePipeline([middleware], context, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(Array.isArray(context.agentState.logs)).toBe(true);
    expect((context.agentState.logs as Array<Record<string, unknown>>)[1]?.phase).toBe("error");
  });

  it("resolves known middleware and keeps unknown middleware pass-through", async () => {
    const resolved = await resolveExecutionMiddlewares([
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

  it("loads middleware from module export via dynamic import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-middleware-"));
    const modulePath = join(dir, "dynamic-middleware.mjs");
    writeFileSync(
      modulePath,
      [
        "export function createMiddleware(params = {}) {",
        "  return async (context, next) => {",
        "    context.agentState.dynamic_middleware_value = params.value ?? 'default';",
        "    return next(context);",
        "  };",
        "}",
      ].join("\n"),
    );

    const resolved = await resolveExecutionMiddlewares([
      {
        import: `${modulePath}:createMiddleware`,
        params: { value: "loaded" },
      },
    ]);

    const context = createContext({});
    const result = await runExecutionMiddlewarePipeline(resolved, context, async () => ({
      status: "completed",
      output: "ok",
      iterations: 1,
      messages: [],
      events: [],
    }));

    expect(result.status).toBe("completed");
    expect(context.agentState.dynamic_middleware_value).toBe("loaded");
  });

  it("supports file:// module specifier for dynamic middleware import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-middleware-file-url-"));
    const modulePath = join(dir, "dynamic-middleware.mjs");
    writeFileSync(
      modulePath,
      [
        "export default function(params = {}) {",
        "  return async (context, next) => {",
        "    context.agentState.dynamic_from_file_url = params.flag ?? false;",
        "    return next(context);",
        "  };",
        "}",
      ].join("\n"),
    );

    const fileUrl = `file://${modulePath}`;
    const resolved = await resolveExecutionMiddlewares([
      {
        import: fileUrl,
        params: { flag: true },
      },
    ]);

    const context = createContext({});
    const result = await runExecutionMiddlewarePipeline(resolved, context, async () => ({
      status: "completed",
      output: "ok",
      iterations: 1,
      messages: [],
      events: [],
    }));

    expect(result.status).toBe("completed");
    expect(context.agentState.dynamic_from_file_url).toBe(true);
  });

  it("falls back to pass-through when module candidate list is empty", async () => {
    const resolved = await resolveExecutionMiddlewares([
      {
        import: "./definitely-not-existing-middleware-module",
      },
    ]);

    const context = createContext({});
    const result = await runExecutionMiddlewarePipeline(resolved, context, async () => ({
      status: "completed",
      output: "ok",
      iterations: 1,
      messages: [],
      events: [],
    }));

    expect(result.status).toBe("completed");
    expect(context.agentState.middleware_logs).toBeUndefined();
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
