import { describe, expect, it } from "vitest";

import { Tool } from "../../../tool/tool.js";
import { HybridToolSelector } from "./hybrid-selector.js";
import { PassthroughToolSelector } from "./passthrough-selector.js";

function buildTool(name: string, description: string, required: string[] = []): Tool {
  return new Tool({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {},
      required,
      additionalProperties: false,
    },
    implementation: async () => ({ ok: true }),
  });
}

describe("tool selector", () => {
  it("passthrough selector returns full tool list", async () => {
    const selector = new PassthroughToolSelector();
    const tools = [
      buildTool("docs.document.get", "read docs"),
      buildTool("base.record.create", "create base record"),
    ];

    const result = await selector.select({
      query: "read document",
      tools,
      messages: [],
      agentState: {},
      iteration: 1,
    });

    expect(result.selectedToolNames).toEqual(["docs.document.get", "base.record.create"]);
    expect(result.trace.mode).toBe("passthrough");
  });

  it("hybrid selector routes to docs domain and reduces tool set", async () => {
    const selector = new HybridToolSelector({
      enabled: true,
      top_k: 2,
      per_domain_k: 2,
      domains: {
        docs: ["document", "doc"],
        base: ["record", "table"],
        messenger: ["message", "chat"],
      },
    });

    const tools = [
      buildTool("docs.document.get", "read document detail", ["document_id"]),
      buildTool("docs.document.raw_content", "read full document", ["document_id"]),
      buildTool("base.record.create", "create base record", ["app_token", "table_id"]),
      buildTool("messenger.message.reply", "reply chat message", ["message_id"]),
    ];

    const result = await selector.select({
      query: "please summarize this document by document_id",
      tools,
      messages: [],
      agentState: {},
      iteration: 1,
    });

    expect(result.selectedToolNames.length).toBeLessThan(tools.length);
    expect(result.selectedToolNames.every((name) => name.startsWith("docs."))).toBe(true);
    expect(result.trace.mode).toBe("hybrid");
    expect(result.trace.routed_domains).toContain("docs");
  });

  it("hybrid selector keeps LoadSkill even in readonly mode", async () => {
    const selector = new HybridToolSelector({
      enabled: true,
      top_k: 4,
      per_domain_k: 2,
      readonly_mode: true,
      risky_write_tools: ["docs.document.create"],
      domains: {
        docs: ["document"],
      },
    });

    const tools = [
      buildTool("docs.document.create", "create document"),
      buildTool("docs.document.get", "get document", ["document_id"]),
      buildTool("LoadSkill", "load a skill"),
    ];

    const result = await selector.select({
      query: "read document",
      tools,
      messages: [],
      agentState: {},
      iteration: 2,
    });

    expect(result.selectedToolNames).toContain("LoadSkill");
    expect(result.selectedToolNames).not.toContain("docs.document.create");
  });
});
