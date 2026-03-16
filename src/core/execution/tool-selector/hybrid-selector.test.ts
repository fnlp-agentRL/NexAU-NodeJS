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

  it("hybrid selector routes to base tools from Feishu base link", async () => {
    const selector = new HybridToolSelector({
      enabled: true,
      top_k: 2,
      per_domain_k: 2,
      domains: {
        base: ["多维表", "bitable"],
        docs: ["document", "doc"],
        sheets: ["sheet", "excel"],
      },
    });

    const tools = [
      buildTool("base.table.create", "create base table", ["app_token"]),
      buildTool("base.field.create", "create base field", ["app_token", "table_id"]),
      buildTool("docs.document.get", "read document", ["document_id"]),
      buildTool("sheets.sheet.get", "read sheet", ["spreadsheet_token", "sheet_id"]),
    ];

    const result = await selector.select({
      query: "请根据这个链接创建字段 https://tenant.feishu.cn/base/KDlsbB6ROanouss9RBBc0Vu2nld",
      tools,
      messages: [],
      agentState: {},
      iteration: 3,
    });
    const trace = result.trace as Record<string, unknown>;
    const routedDomains = (trace.routed_domains ?? []) as string[];
    const linkSignalDomains = (trace.link_signal_domains ?? []) as string[];
    const detectedLinkCount = Number(trace.detected_link_count ?? 0);

    expect(result.selectedToolNames).toContain("base.table.create");
    expect(result.selectedToolNames.every((name) => name.startsWith("base."))).toBe(true);
    expect(routedDomains[0]).toBe("base");
    expect(detectedLinkCount).toBeGreaterThan(0);
    expect(linkSignalDomains).toContain("base");
  });
});
