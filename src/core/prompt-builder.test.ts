import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Tool } from "../tool/tool.js";
import { PromptBuilder } from "./prompt-builder.js";
import type { AgentConfig } from "./agent-config.js";

function buildAgentStub(
  overrides: Partial<{
    name: string;
    system_prompt: string | Array<string | { content: string; cache: boolean }>;
    system_prompt_type: "string" | "file" | "jinja";
    system_prompt_suffix: string;
    tools: Tool[];
    sub_agents: Record<string, AgentConfig>;
    sandbox_config: Record<string, unknown>;
  }> = {},
): AgentConfig {
  return {
    name: "demo_agent",
    system_prompt_type: "string",
    system_prompt: "Base {{date}}",
    system_prompt_suffix: undefined,
    tools: [],
    sub_agents: {},
    sandbox_config: undefined,
    ...overrides,
  } as unknown as AgentConfig;
}

function buildTypedTool(name: string): Tool {
  return new Tool({
    name,
    description: "typed tool",
    inputSchema: {
      type: "object",
      properties: {
        s: { type: "string", description: "text" },
        i: { type: "integer", description: "int value" },
        n: { type: "number", description: "float value" },
        b: { type: "boolean", description: "flag" },
        a: { type: "array", description: "list value" },
        o: { type: "object", description: "obj value" },
      },
      required: ["s", "i"],
      additionalProperties: false,
    },
    implementation: async () => ({ ok: true }),
  });
}

describe("PromptBuilder", () => {
  it("builds xml capability docs and execution instructions", () => {
    const builder = new PromptBuilder();
    const tool = buildTypedTool("typed_tool");
    const skillTool = new Tool({
      name: "save_memory",
      description: "save memory",
      inputSchema: { type: "object", properties: {} },
      implementation: async () => ({ ok: true }),
      asSkill: true,
      skillDescription: "Store one durable user/project fact for later rounds.",
    });
    const overrideTool = new Tool({
      name: "override_tool",
      description: "override",
      inputSchema: { type: "object", properties: {} },
      implementation: async () => ({ ok: true }),
      templateOverride: "Custom tool usage block",
    });
    const agent = buildAgentStub({
      tools: [tool, skillTool, overrideTool],
      sub_agents: {
        worker: buildAgentStub({ name: "worker", system_prompt: "child" }),
      },
    });

    const parts = builder.buildSystemPrompt(
      agent,
      agent.tools,
      agent.sub_agents,
      { date: "2026-03-18" },
      true,
    );
    expect(parts.length).toBe(1);
    const text = parts[0]!.text;
    expect(text).toContain("Base 2026-03-18");
    expect(text).toContain("## Available Tools");
    expect(text).toContain("### typed_tool");
    expect(text).toContain("(required, type: str)");
    expect(text).toContain("(required, type: int)");
    expect(text).toContain("(optional, type: float)");
    expect(text).toContain("(optional, type: bool)");
    expect(text).toContain("(optional, type: list)");
    expect(text).toContain("(optional, type: dict)");
    expect(text).toContain("### save_memory");
    expect(text).toContain("Store one durable user/project fact for later rounds.");
    expect(text).toContain("Custom tool usage block");
    expect(text).toContain("## Available Sub-Agents");
    expect(text).toContain("<tool_name>agent:worker</tool_name>");
    expect(text).toContain("CRITICAL TOOL EXECUTION INSTRUCTIONS");
  });

  it("supports block prompts, suffix/NEXAU.md injection, and disabled tool instructions", () => {
    const builder = new PromptBuilder();
    const dir = mkdtempSync(join(tmpdir(), "nexau-prompt-builder-"));
    writeFileSync(join(dir, "NEXAU.md"), "Project policy");
    const firstPromptPath = join(dir, "first.md");
    writeFileSync(firstPromptPath, "First block");
    const promptPath = join(dir, "systemprompt.md");
    writeFileSync(promptPath, "Prompt from file {{date}}");

    const agent = buildAgentStub({
      system_prompt_type: "jinja",
      system_prompt: [
        { content: firstPromptPath, cache: false },
        { content: promptPath, cache: true },
      ],
      system_prompt_suffix: "\nSuffix",
      sandbox_config: { work_dir: dir },
    });

    const parts = builder.buildSystemPrompt(agent, [], {}, { date: "2026-03-18" }, false);
    expect(parts.length).toBe(2);
    expect(parts[0]).toEqual({ text: "First block", cache: false });
    expect(parts[1]!.text).toContain("Prompt from file 2026-03-18");
    expect(parts[1]!.text).toContain("Suffix");
    expect(parts[1]!.text).toContain("# Project Instructions (NEXAU.md)");
    expect(parts[1]!.text).toContain("Project policy");

    const defaultAgent = buildAgentStub({
      system_prompt: undefined,
      system_prompt_type: "string",
    });
    const defaultParts = builder.buildSystemPrompt(defaultAgent, [], {}, {}, false);
    expect(defaultParts[0]!.text).toContain("You are an AI agent named");

    // Cover defensive internal branches.
    const emptyParts: Array<{ text: string; cache: boolean }> = [];
    (builder as unknown as { appendSuffixAndNexauMd: (...args: unknown[]) => void }).appendSuffixAndNexauMd(
      emptyParts,
      agent,
      {},
    );
    expect(emptyParts).toEqual([]);
    expect(
      (
        builder as unknown as {
          buildSubAgentsDocumentation: (value: Record<string, AgentConfig>) => string;
        }
      ).buildSubAgentsDocumentation({}),
    ).toBe("");
  });

  it("handles missing or absent NEXAU.md gracefully", () => {
    const builder = new PromptBuilder();
    const dir = mkdtempSync(join(tmpdir(), "nexau-prompt-builder-no-nexau-"));
    const promptPath = join(dir, "systemprompt.md");
    writeFileSync(promptPath, "Prompt content");

    const agentWithMissingNexau = buildAgentStub({
      system_prompt_type: "jinja",
      system_prompt: promptPath,
      sandbox_config: { work_dir: dir },
    });
    const parts = builder.buildSystemPrompt(agentWithMissingNexau, [], {}, {}, false);
    expect(parts[0]!.text).toBe("Prompt content");

    const agentNoSandbox = buildAgentStub({
      system_prompt_type: "jinja",
      system_prompt: promptPath,
      sandbox_config: undefined,
    });
    const partsNoSandbox = builder.buildSystemPrompt(agentNoSandbox, [], {}, {}, false);
    expect(partsNoSandbox[0]!.text).toBe("Prompt content");
  });
});
