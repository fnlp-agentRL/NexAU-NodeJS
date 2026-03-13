import { describe, expect, it } from "vitest";

import { CompositeTracer } from "./composite.js";
import { resolveTracer } from "./resolve.js";

describe("resolveTracer", () => {
  it("returns null for empty definitions", () => {
    expect(resolveTracer(undefined)).toBeNull();
    expect(resolveTracer([])).toBeNull();
  });

  it("creates single tracer for langfuse hook", () => {
    const tracer = resolveTracer([
      { import: "nexau.archs.tracer.adapters.langfuse:LangfuseTracer" },
    ]);
    expect(tracer).not.toBeNull();
    expect(tracer).not.toBeInstanceOf(CompositeTracer);
  });

  it("creates composite tracer for multiple known hooks", () => {
    const tracer = resolveTracer([
      { import: "nexau.archs.tracer.adapters.in_memory:InMemoryTracer" },
      { import: "nexau.archs.tracer.adapters.langfuse:LangfuseTracer", params: { enabled: false } },
    ]);
    expect(tracer).toBeInstanceOf(CompositeTracer);
  });
});
