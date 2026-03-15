import { describe, expect, it } from "vitest";

import { resolveToolSelector } from "./resolve.js";

describe("resolveToolSelector", () => {
  it("returns null when selector middleware is absent", () => {
    const resolved = resolveToolSelector([
      { import: "nexau.archs.main_sub.execution.hooks:LoggingMiddleware" },
    ]);

    expect(resolved).toBeNull();
  });

  it("resolves hybrid selector from middleware import", () => {
    const resolved = resolveToolSelector([
      {
        import: "nexau.archs.main_sub.execution.middleware.tool_selector:HybridSelector",
        params: {
          top_k: 8,
        },
      },
    ]);

    expect(resolved).toBeTruthy();
    expect(resolved?.mode).toBe("hybrid");
    expect(typeof resolved?.selector.select).toBe("function");
  });

  it("falls back to passthrough selector for unsupported selector import", () => {
    const resolved = resolveToolSelector([
      {
        import: "custom.tool_selector:MySelector",
      },
    ]);

    expect(resolved?.mode).toBe("passthrough");
    expect(resolved?.error).toContain("Unsupported tool selector import");
  });
});
