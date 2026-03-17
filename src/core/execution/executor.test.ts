import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentConfig } from "../agent-config.js";
import { Agent } from "../agent.js";
import { Tool } from "../../tool/tool.js";
import { AgentExecutor } from "./executor.js";
import type { LLMClient, LLMCompleteInput, LLMResponse } from "./types.js";

class ScriptedLLMClient implements LLMClient {
  private readonly responses: LLMResponse[];
  private index = 0;
  public calls: Array<LLMCompleteInput> = [];

  public constructor(responses: LLMResponse[]) {
    if (responses.length === 0) {
      throw new Error("ScriptedLLMClient requires at least one response");
    }
    this.responses = responses;
  }

  public async complete(input: LLMCompleteInput): Promise<LLMResponse> {
    this.calls.push(input);
    const response = this.responses[this.index] ?? this.responses[this.responses.length - 1]!;
    this.index += 1;
    return response;
  }
}

function buildToolYaml(
  dir: string,
  options: {
    skillDescription?: string;
  } = {},
): string {
  const toolPath = join(dir, "write_todos.tool.yaml");
  const lines = ["type: tool", "name: write_todos", "description: write todos"];
  if (options.skillDescription) {
    lines.push(`skill_description: ${options.skillDescription}`);
  }
  lines.push(
    "input_schema:",
    "  type: object",
    "  properties:",
    "    todos:",
    "      type: array",
    "  required:",
    "    - todos",
    "  additionalProperties: false",
  );
  writeFileSync(toolPath, lines.join("\n"));
  return toolPath;
}

function buildAgentYaml(
  dir: string,
  options: {
    stopTools?: string[];
    maxIterations?: number;
    maxContextTokens?: number;
    subAgentPath?: string;
    extraLines?: string[];
    asSkill?: boolean;
  } = {},
): string {
  const stopTools = options.stopTools ?? [];
  const lines = [
    "type: agent",
    "name: test_agent",
    `max_iterations: ${options.maxIterations ?? 10}`,
    `max_context_tokens: ${options.maxContextTokens ?? 128000}`,
    "llm_config:",
    "  model: test-model",
    "  base_url: https://example.com/v1",
    "  api_key: test-key",
    "tools:",
    "  - name: write_todos",
    "    yaml_path: ./write_todos.tool.yaml",
    "    binding: nexau.archs.tool.builtin.session_tools:write_todos",
  ];
  if (options.asSkill) {
    lines.push("    as_skill: true");
  }

  if (stopTools.length > 0) {
    lines.push(`stop_tools: [${stopTools.join(", ")}]`);
  }

  if (options.subAgentPath) {
    lines.push("sub_agents:");
    lines.push("  - name: child");
    lines.push(`    config_path: ${options.subAgentPath}`);
  }

  if (options.extraLines && options.extraLines.length > 0) {
    lines.push(...options.extraLines);
  }

  const path = join(dir, "agent.yaml");
  writeFileSync(path, lines.join("\n"));
  return path;
}

function buildSubAgentYaml(dir: string): string {
  const childPath = join(dir, "child.yaml");
  writeFileSync(
    childPath,
    [
      "type: agent",
      "name: child_agent",
      "max_iterations: 3",
      "llm_config:",
      "  model: child-model",
      "  base_url: https://example.com/v1",
      "  api_key: test-key",
    ].join("\n"),
  );
  return childPath;
}

describe("AgentExecutor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("completes when llm returns plain text with no tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-plain-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir);

    const config = AgentConfig.fromYaml(configPath);
    const scripted = new ScriptedLLMClient([
      {
        content: "final answer",
      },
    ]);

    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });

    const result = await executor.execute({
      agent: config,
      input: "hello",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("final answer");
    expect(result.iterations).toBe(1);
  });

  it("appends dynamic system prompt addition to system message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-dynamic-system-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: ["system_prompt: |", "  Base instruction"],
    });

    const config = AgentConfig.fromYaml(configPath);
    const scripted = new ScriptedLLMClient([
      {
        content: "ok",
      },
    ]);

    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });

    await executor.execute({
      agent: config,
      input: "hello",
      systemPromptAddition: "Dynamic instruction",
    });

    const firstCall = scripted.calls[0];
    expect(firstCall).toBeTruthy();
    const systemMessage = firstCall?.messages.find((message) => message.role === "system");
    expect(systemMessage).toBeTruthy();
    expect(systemMessage?.content).toContain("Base instruction");
    expect(systemMessage?.content).toContain("Dynamic instruction");
  });

  it("renders jinja-style variables in system prompt files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-jinja-system-"));
    buildToolYaml(dir);
    const promptPath = join(dir, "systemprompt.md");
    writeFileSync(promptPath, "Today is {{date}}.");
    const configPath = buildAgentYaml(dir, {
      extraLines: ["system_prompt: ./systemprompt.md", "system_prompt_type: jinja"],
    });

    const config = AgentConfig.fromYaml(configPath);
    const scripted = new ScriptedLLMClient([
      {
        content: "ok",
      },
    ]);

    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });

    await executor.execute({
      agent: config,
      input: "hello",
    });

    const firstCall = scripted.calls[0];
    const systemMessage = firstCall?.messages.find((message) => message.role === "system");
    expect(systemMessage).toBeTruthy();
    expect(systemMessage?.content).toContain("Today is ");
    expect(systemMessage?.content).not.toContain("{{date}}");
  });

  it("emits prompt/tool token estimates in llm.requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-token-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir);

    const config = AgentConfig.fromYaml(configPath);
    const scripted = new ScriptedLLMClient([
      {
        content: "final answer",
      },
    ]);

    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });

    const result = await executor.execute({
      agent: config,
      input: "hello",
    });

    const requested = result.events.find((event) => event.type === "llm.requested");
    expect(requested).toBeTruthy();
    expect(typeof requested?.payload.prompt_tokens_estimated).toBe("number");
    expect(typeof requested?.payload.prompt_tool_tokens_estimated).toBe("number");
    expect(typeof requested?.payload.prompt_message_tokens_estimated).toBe("number");
    expect(Number(requested?.payload.prompt_tokens_estimated)).toBeGreaterThan(0);
    expect(Number(requested?.payload.prompt_tool_tokens_estimated)).toBeGreaterThan(0);
    expect(Number(requested?.payload.prompt_message_tokens_estimated)).toBeGreaterThan(0);
  });

  it("runs tool loop and returns final llm output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-tool-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir);

    const config = AgentConfig.fromYaml(configPath);
    const scripted = new ScriptedLLMClient([
      {
        content: "calling tool",
        tool_calls: [
          {
            id: "call-1",
            name: "write_todos",
            arguments: {
              todos: [{ description: "a", status: "in_progress" }],
            },
          },
        ],
      },
      {
        content: "done after tool",
      },
    ]);

    const agentState: Record<string, unknown> = {};
    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });

    const result = await executor.execute({
      agent: config,
      input: "do work",
      agentState,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("done after tool");
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
    const toolCalled = result.events.find((event) => event.type === "tool.called");
    expect(toolCalled?.payload.tool_name).toBe("write_todos");
    expect(toolCalled?.payload.tool_arguments).toEqual({
      todos: [{ description: "a", status: "in_progress" }],
    });
    expect((agentState as { todos?: unknown[] }).todos?.length).toBe(1);
  });

  it("stops immediately when stop_tools is hit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-stop-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, { stopTools: ["write_todos"] });

    const config = AgentConfig.fromYaml(configPath);
    const scripted = new ScriptedLLMClient([
      {
        content: "tool before stop",
        tool_calls: [
          {
            id: "call-stop",
            name: "write_todos",
            arguments: {
              todos: [{ description: "stop", status: "completed" }],
            },
          },
        ],
      },
      {
        content: "should never run",
      },
    ]);

    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });

    const result = await executor.execute({
      agent: config,
      input: "trigger stop",
      agentState: {},
    });

    expect(result.status).toBe("stopped_by_tool");
    expect(result.stop_tool_name).toBe("write_todos");
    expect(scripted.calls.length).toBe(1);
  });

  it("supports minimal sub-agent closure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-subagent-"));
    buildToolYaml(dir);
    buildSubAgentYaml(dir);
    const configPath = buildAgentYaml(dir, {
      subAgentPath: "./child.yaml",
    });

    const parentConfig = AgentConfig.fromYaml(configPath);

    const parentClient = new ScriptedLLMClient([
      {
        content: "delegating",
        tool_calls: [
          {
            id: "sub-1",
            name: "RecallSubAgent",
            arguments: {
              sub_agent_name: "child_agent",
              message: "sub task",
            },
          },
        ],
      },
      {
        content: "sub-agent merged result",
      },
    ]);
    const childClient = new ScriptedLLMClient([
      {
        content: "child answer",
      },
    ]);

    const executor = new AgentExecutor({
      createLLMClient: (agent) => (agent.name === "child_agent" ? childClient : parentClient),
    });

    const result = await executor.execute({
      agent: parentConfig,
      input: "run child",
      agentState: {},
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("sub-agent merged result");
    expect(childClient.calls.length).toBe(1);
    expect(
      result.events.some(
        (event) =>
          event.type === "subagent.completed" && event.payload.sub_agent_name === "child_agent",
      ),
    ).toBe(true);
  });

  it("includes canonical sub-agent tools in structured openai payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-subagent-payload-"));
    buildToolYaml(dir);
    buildSubAgentYaml(dir);
    const configPath = buildAgentYaml(dir, {
      subAgentPath: "./child.yaml",
      extraLines: ["tool_call_mode: openai"],
    });
    const config = AgentConfig.fromYaml(configPath);

    const scripted = new ScriptedLLMClient([{ content: "ok" }]);
    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });

    const result = await executor.execute({
      agent: config,
      input: "hello",
      agentState: {},
    });

    expect(result.status).toBe("completed");
    expect(
      scripted.calls[0]?.tools.some((tool) => {
        const fn = tool.function as { name?: string } | undefined;
        return fn?.name === "sub-agent-child_agent";
      }),
    ).toBe(true);
  });

  it("uses anthropic tool payload shape when tool_call_mode is anthropic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-anthropic-payload-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: ["tool_call_mode: anthropic"],
    });
    const config = AgentConfig.fromYaml(configPath);

    const scripted = new ScriptedLLMClient([{ content: "ok" }]);
    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });

    await executor.execute({
      agent: config,
      input: "hello",
    });

    const firstTool = scripted.calls[0]?.tools[0] as
      | { name?: string; input_schema?: unknown; function?: unknown }
      | undefined;
    expect(firstTool).toBeTruthy();
    expect(typeof firstTool?.name).toBe("string");
    expect(firstTool?.input_schema).toBeTruthy();
    expect(firstTool?.function).toBeUndefined();
  });

  it("parses xml tool calls in xml mode and executes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-xml-mode-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: ["tool_call_mode: xml", "system_prompt: |", "  XML mode agent."],
    });
    const config = AgentConfig.fromYaml(configPath);

    const scripted = new ScriptedLLMClient([
      {
        content: `<tool_use>
  <tool_name>write_todos</tool_name>
  <parameter>
    <todos>[{"description":"item","status":"in_progress"}]</todos>
  </parameter>
</tool_use>`,
      },
      {
        content: "final",
      },
    ]);

    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });

    const result = await executor.execute({
      agent: config,
      input: "run xml call",
      agentState: {},
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("final");
    expect(
      result.events.some(
        (event) => event.type === "tool.called" && event.payload.tool_name === "write_todos",
      ),
    ).toBe(true);
    expect(scripted.calls[0]?.tools.length).toBe(0);
    const systemMessage = scripted.calls[0]?.messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain("CRITICAL TOOL EXECUTION INSTRUCTIONS");
    expect(systemMessage?.content).toContain("## Available Tools");
  });

  it("parses parallel xml tool calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-xml-parallel-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: ["tool_call_mode: xml"],
    });
    const config = AgentConfig.fromYaml(configPath);

    const scripted = new ScriptedLLMClient([
      {
        content: `<use_parallel_tool_calls>
<parallel_tool>
  <tool_name>write_todos</tool_name>
  <parameter>
    <todos>[{"description":"a","status":"in_progress"}]</todos>
  </parameter>
</parallel_tool>
<parallel_tool>
  <tool_name>write_todos</tool_name>
  <parameter>
    <todos>[{"description":"b","status":"completed"}]</todos>
  </parameter>
</parallel_tool>
</use_parallel_tool_calls>`,
      },
      { content: "done" },
    ]);

    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });
    const result = await executor.execute({
      agent: config,
      input: "parallel xml",
      agentState: {},
    });

    expect(result.status).toBe("completed");
    const calledEvents = result.events.filter(
      (event) => event.type === "tool.called" && event.payload.tool_name === "write_todos",
    );
    expect(calledEvents.length).toBe(2);
  });

  it("retries transient llm failure and applies context compaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-retry-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      maxIterations: 2,
      maxContextTokens: 8,
    });

    const config = AgentConfig.fromYaml(configPath);
    let first = true;

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete(input) {
          if (first) {
            first = false;
            throw new Error("transient");
          }
          return {
            content: `ok (${input.messages.length})`,
          };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "this is a long user message that should trigger compaction",
      history: [
        { role: "assistant", content: "historical message one" },
        { role: "assistant", content: "historical message two" },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.output.startsWith("ok")).toBe(true);
    expect(result.events.some((event) => event.type === "context.compacted")).toBe(true);
  });

  it("fails when llm timeout exceeds configured limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-timeout-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir);

    const config = AgentConfig.fromYaml(configPath);
    (config as unknown as { timeout: number; retry_attempts: number }).timeout = 0;
    (config as unknown as { timeout: number; retry_attempts: number }).retry_attempts = 0;

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { content: "late" };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "timeout",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("timed out");
  });

  it("truncates oversized tool output when long_tool_output middleware is enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-long-output-"));
    const outputDir = mkdtempSync(join(tmpdir(), "nexau-executor-long-output-files-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.long_tool_output:LongToolOutputMiddleware",
        "    params:",
        "      max_output_chars: 200",
        "      head_chars: 60",
        "      tail_chars: 60",
        `      temp_dir: ${outputDir}`,
      ],
    });
    const config = AgentConfig.fromYaml(configPath);
    (config as unknown as { retry_attempts: number }).retry_attempts = 0;

    (config as { tools: Tool[] }).tools = [
      new Tool({
        name: "huge_tool",
        description: "returns huge payload",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        implementation: async () => ({
          content: "A".repeat(1200),
        }),
      }),
    ];

    let step = 0;
    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "",
              tool_calls: [{ id: "huge-1", name: "huge_tool", arguments: {} }],
            };
          }
          return {
            content: "done",
          };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "run huge tool",
    });

    expect(result.status).toBe("completed");
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeTruthy();
    const parsedToolMessage = JSON.parse(String(toolMessage?.content ?? "{}")) as {
      content?: string;
    };
    expect(typeof parsedToolMessage.content).toBe("string");
    expect(parsedToolMessage.content).toContain("[LongToolOutputMiddleware] The full output");
    expect(parsedToolMessage.content).toContain("[");
    const toolCompleted = result.events.find((event) => event.type === "tool.completed");
    expect(toolCompleted?.payload.tool_output_truncated).toBe(true);
    expect(typeof toolCompleted?.payload.tool_output_saved_path).toBe("string");
    const savedPath = String(toolCompleted?.payload.tool_output_saved_path ?? "");
    expect(readFileSync(savedPath, "utf-8")).toContain("A".repeat(800));
  });

  it("ignores returnDisplay when evaluating long_tool_output truncation threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-long-output-return-display-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.long_tool_output:LongToolOutputMiddleware",
        "    params:",
        "      max_output_chars: 180",
        "      head_chars: 60",
        "      tail_chars: 60",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);
    (config as unknown as { retry_attempts: number }).retry_attempts = 0;

    (config as { tools: Tool[] }).tools = [
      new Tool({
        name: "display_tool",
        description: "returns short content and huge returnDisplay",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        implementation: async () => ({
          content: "short content",
          returnDisplay: "B".repeat(4000),
        }),
      }),
    ];

    let step = 0;
    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "",
              tool_calls: [{ id: "display-1", name: "display_tool", arguments: {} }],
            };
          }
          return {
            content: "done",
          };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "run display tool",
    });

    expect(result.status).toBe("completed");
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeTruthy();
    const parsedToolMessage = JSON.parse(String(toolMessage?.content ?? "{}")) as {
      content?: string;
      returnDisplay?: string;
    };
    expect(parsedToolMessage.content).toBe("short content");
    expect(parsedToolMessage.returnDisplay).toBeUndefined();
    const toolCompleted = result.events.find((event) => event.type === "tool.completed");
    expect(toolCompleted?.payload.tool_output_truncated).not.toBe(true);
    expect(toolCompleted?.payload.tool_output_saved_path).toBeUndefined();
  });

  it("throws on invalid long_tool_output character window config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-long-output-invalid-window-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.long_tool_output:LongToolOutputMiddleware",
        "    params:",
        "      max_output_chars: 100",
        "      head_chars: 60",
        "      tail_chars: 50",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          return { content: "ok" };
        },
      }),
    });

    await expect(
      executor.execute({
        agent: config,
        input: "invalid config",
      }),
    ).rejects.toThrow("head_chars + tail_chars must be <= max_output_chars");
  });

  it("throws on invalid long_tool_output bypass_tool_names type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-long-output-invalid-bypass-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.long_tool_output:LongToolOutputMiddleware",
        "    params:",
        "      bypass_tool_names: write_todos",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          return { content: "ok" };
        },
      }),
    });

    await expect(
      executor.execute({
        agent: config,
        input: "invalid bypass config",
      }),
    ).rejects.toThrow("bypass_tool_names must be an array of strings");
  });

  it("throws on invalid long_tool_output max_output_chars value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-long-output-invalid-max-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.long_tool_output:LongToolOutputMiddleware",
        "    params:",
        "      max_output_chars: 0",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          return { content: "ok" };
        },
      }),
    });

    await expect(
      executor.execute({
        agent: config,
        input: "invalid max chars",
      }),
    ).rejects.toThrow("max_output_chars must be >= 1");
  });

  it("throws on invalid long_tool_output temp_dir type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-long-output-invalid-temp-dir-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.long_tool_output:LongToolOutputMiddleware",
        "    params:",
        "      temp_dir: 123",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          return { content: "ok" };
        },
      }),
    });

    await expect(
      executor.execute({
        agent: config,
        input: "invalid temp dir",
      }),
    ).rejects.toThrow("temp_dir must be a string or null");
  });

  it("throws when long_tool_output bypass_tool_names has empty item", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-long-output-invalid-bypass-item-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.long_tool_output:LongToolOutputMiddleware",
        "    params:",
        "      bypass_tool_names: ['']",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          return { content: "ok" };
        },
      }),
    });

    await expect(
      executor.execute({
        agent: config,
        input: "invalid bypass item",
      }),
    ).rejects.toThrow("bypass_tool_names must contain non-empty strings");
  });

  it("fails over to fallback llm provider when trigger condition matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-failover-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.llm_failover:LLMFailoverMiddleware",
        "    params:",
        "      trigger:",
        "        status_codes: [500]",
        "      fallback_providers:",
        "        - name: backup",
        "          llm_config:",
        "            model: fallback-model",
        "            base_url: https://example.com/v1",
        "            api_key: test-key",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);
    (config as unknown as { retry_attempts: number }).retry_attempts = 0;

    let primaryCalls = 0;
    let fallbackCalls = 0;
    const executor = new AgentExecutor({
      createLLMClient: (agent) => {
        if (agent.llm_config.model === "fallback-model") {
          return {
            async complete() {
              fallbackCalls += 1;
              return {
                content: "fallback response",
              };
            },
          };
        }

        return {
          async complete() {
            primaryCalls += 1;
            throw new Error("LLM request failed (500): upstream");
          },
        };
      },
    });

    const result = await executor.execute({
      agent: config,
      input: "trigger failover",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("fallback response");
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(result.events.some((event) => event.type === "llm.failover.triggered")).toBe(true);
    expect(result.events.some((event) => event.type === "llm.failover.succeeded")).toBe(true);
  });

  it("does not trigger failover when status code is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-failover-skip-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.llm_failover:LLMFailoverMiddleware",
        "    params:",
        "      trigger:",
        "        status_codes: [500]",
        "      fallback_providers:",
        "        - name: backup",
        "          llm_config:",
        "            model: fallback-model",
        "            base_url: https://example.com/v1",
        "            api_key: test-key",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    let fallbackCalls = 0;
    const executor = new AgentExecutor({
      createLLMClient: (agent) => {
        if (agent.llm_config.model === "fallback-model") {
          return {
            async complete() {
              fallbackCalls += 1;
              return {
                content: "should not happen",
              };
            },
          };
        }
        return {
          async complete() {
            throw new Error("LLM request failed (400): bad request");
          },
        };
      },
    });

    const result = await executor.execute({
      agent: config,
      input: "no failover",
    });

    expect(result.status).toBe("failed");
    expect(fallbackCalls).toBe(0);
    expect(result.events.some((event) => event.type === "llm.failover.triggered")).toBe(false);
  });

  it("wraps executor via Agent.run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-agent-run-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir);
    const config = AgentConfig.fromYaml(configPath);

    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete() {
          return { content: "agent run ok" };
        },
      }),
    });

    const result = await agent.run("hello agent");
    expect(result.output).toBe("agent run ok");
  });

  it("applies middleware pipeline around execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-middleware-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.hooks:LoggingMiddleware",
        "    params:",
        "      state_key: exec_logs",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          return { content: "middleware done" };
        },
      }),
    });

    const state: Record<string, unknown> = {};
    const result = await executor.execute({
      agent: config,
      input: "run middleware",
      agentState: state,
    });

    expect(result.status).toBe("completed");
    expect(Array.isArray(state.exec_logs)).toBe(true);
    expect((state.exec_logs as unknown[]).length).toBe(2);
  });

  it("selects a reduced tool subset when hybrid tool selector is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-tool-selector-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.tool_selector:HybridSelector",
        "    params:",
        "      enabled: true",
        "      top_k: 1",
        "      per_domain_k: 1",
        "      domains:",
        "        docs: [document, doc]",
        "        base: [record, table]",
        "        messenger: [message, chat]",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    (config as { tools: Tool[] }).tools = [
      new Tool({
        name: "docs.document.get",
        description: "Read document content",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        implementation: async () => ({ ok: true }),
      }),
      new Tool({
        name: "base.record.create",
        description: "Create base record",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        implementation: async () => ({ ok: true }),
      }),
      new Tool({
        name: "messenger.message.reply",
        description: "Reply message",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        implementation: async () => ({ ok: true }),
      }),
    ];

    const requestedToolNames: string[][] = [];
    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete(input) {
          const names = input.tools.map((tool) =>
            String((tool.function as { name?: string } | undefined)?.name ?? ""),
          );
          requestedToolNames.push(names);
          return {
            content: "selector done",
          };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "read this document",
      agentState: {},
    });

    expect(result.status).toBe("completed");
    expect(requestedToolNames.length).toBe(1);
    expect(requestedToolNames[0]?.length).toBe(1);
    expect(requestedToolNames[0]?.[0]).toBe("docs.document.get");
    expect(result.events.some((event) => event.type === "tool.selection")).toBe(true);
  });

  it("falls back to full tools when selector import is unsupported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-tool-selector-fallback-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: ["middlewares:", "  - import: custom.tool_selector:UnknownSelector"],
    });
    const config = AgentConfig.fromYaml(configPath);

    (config as { tools: Tool[] }).tools = [
      new Tool({
        name: "docs.document.get",
        description: "Read document content",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        implementation: async () => ({ ok: true }),
      }),
      new Tool({
        name: "base.record.create",
        description: "Create base record",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        implementation: async () => ({ ok: true }),
      }),
    ];

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete(input) {
          return {
            content: String(input.tools.length),
          };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "read document",
      agentState: {},
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("2");
    const selectorEvent = result.events.find((event) => event.type === "tool.selection");
    expect(selectorEvent?.payload.selector_error).toContain("Unsupported tool selector import");
  });

  it("uses skill description for structured tools and context-compacts tool results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-skill-compact-"));
    buildToolYaml(dir, {
      skillDescription: "skill description for write_todos",
    });
    const configPath = buildAgentYaml(dir, {
      asSkill: true,
      maxContextTokens: 200,
      extraLines: [
        "middlewares:",
        "  - import: nexau.archs.main_sub.execution.middleware.context_compaction:ContextCompactionMiddleware",
        "    params:",
        "      compaction_strategy: tool_result_compaction",
        "      threshold: 0",
        "      keep_iterations: 1",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    const scripted = new ScriptedLLMClient([
      {
        content: "",
        tool_calls: [
          {
            id: "c1",
            name: "write_todos",
            arguments: {
              todos: [{ description: "a", status: "in_progress" }],
            },
          },
        ],
      },
      {
        content: "",
        tool_calls: [
          {
            id: "c2",
            name: "write_todos",
            arguments: {
              todos: [{ description: "b", status: "in_progress" }],
            },
          },
        ],
      },
      {
        content: "final",
      },
    ]);

    const executor = new AgentExecutor({
      createLLMClient: () => scripted,
    });
    const result = await executor.execute({
      agent: config,
      input: "run",
      agentState: {},
    });

    expect(result.status).toBe("completed");
    expect(
      scripted.calls[0]?.tools.some((tool) => {
        const fn = tool.function as { name?: string; description?: string };
        return fn.name === "write_todos" && fn.description === "skill description for write_todos";
      }),
    ).toBe(true);
    expect(
      scripted.calls[1]?.messages.some(
        (message) => message.role === "assistant" && message.content === "null",
      ),
    ).toBe(true);
    expect(
      result.messages.some(
        (message) => message.role === "tool" && message.content.includes('"todos"'),
      ),
    ).toBe(true);
    expect(
      result.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.includes("Tool call result has been compacted"),
      ),
    ).toBe(true);
    expect(
      result.messages.some((message) => message.role === "tool" && message.name === undefined),
    ).toBe(true);
    expect(
      result.events.some(
        (event) => event.type === "context.compacted" && event.payload.dropped_messages === 0,
      ),
    ).toBe(true);
  });

  it("sends trace payload when langfuse tracer is configured", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      async text() {
        return "";
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-tracer-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      extraLines: [
        "tracers:",
        "  - import: nexau.archs.tracer.adapters.langfuse:LangfuseTracer",
        "    params:",
        "      host: https://langfuse.example",
        "      public_key: pk-test",
        "      secret_key: sk-test",
        "      enabled: true",
      ],
    });
    const config = AgentConfig.fromYaml(configPath);

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          return { content: "trace done" };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "trace this",
      traceContext: {
        userId: "u1",
        sessionId: "s1",
      },
    });

    expect(result.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports interruption before first model call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-interrupt-pre-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir);
    const config = AgentConfig.fromYaml(configPath);

    const controller = new AbortController();
    controller.abort();

    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          return { content: "should not execute" };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "interrupt",
      signal: controller.signal,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Execution interrupted");
    expect(result.events.some((event) => event.type === "run.failed")).toBe(true);
  });

  it("supports interruption during iterative run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-interrupt-mid-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      maxIterations: 4,
    });
    const config = AgentConfig.fromYaml(configPath);

    let step = 0;
    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "tool first",
              tool_calls: [
                {
                  id: "interrupt-t1",
                  name: "write_todos",
                  arguments: {
                    todos: [{ description: "a", status: "pending" }],
                  },
                },
              ],
            };
          }
          return {
            content: "done",
          };
        },
      }),
    });

    const controller = new AbortController();
    const result = await executor.execute({
      agent: config,
      input: "interrupt after first loop",
      signal: controller.signal,
      onEvent(event) {
        if (event.type === "tool.completed") {
          controller.abort();
        }
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Execution interrupted");
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("interrupts while entering sequential tool execution loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-interrupt-tools-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      maxIterations: 2,
    });
    const config = AgentConfig.fromYaml(configPath);

    const toolA = new Tool({
      name: "tool_a",
      description: "tool a",
      inputSchema: {
        type: "object",
        properties: {},
      },
      implementation: async () => ({ ok: "a" }),
      disableParallel: true,
    });
    const toolB = new Tool({
      name: "tool_b",
      description: "tool b",
      inputSchema: {
        type: "object",
        properties: {},
      },
      implementation: async () => ({ ok: "b" }),
    });
    (config as { tools: Tool[] }).tools = [toolA, toolB];

    let step = 0;
    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "call serial tools",
              tool_calls: [
                { id: "a", name: "tool_a", arguments: {} },
                { id: "b", name: "tool_b", arguments: {} },
              ],
            };
          }
          return {
            content: "done",
          };
        },
      }),
    });

    const controller = new AbortController();
    const result = await executor.execute({
      agent: config,
      input: "interrupt on tool loop",
      signal: controller.signal,
      onEvent(event) {
        if (event.type === "tool.called" && event.payload.tool_name === "tool_a") {
          controller.abort();
        }
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Execution interrupted");
    expect(result.events.some((event) => event.type === "run.failed")).toBe(true);
  });

  it("fails run when sequential tool execution throws a non-abort error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-tool-error-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      maxIterations: 2,
    });
    const config = AgentConfig.fromYaml(configPath);

    const errorTool = new Tool({
      name: "error_tool",
      description: "throws",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      implementation: async () => ({ ok: true }),
    });
    (
      errorTool as unknown as {
        execute: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }
    ).execute = async () => {
      throw new Error("tool crashed");
    };
    (config as { tools: Tool[] }).tools = [errorTool];

    let step = 0;
    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "",
              tool_calls: [{ id: "err", name: "error_tool", arguments: {} }],
            };
          }
          return {
            content: "should not reach",
          };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "trigger tool error",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("tool crashed");
    expect(result.events.some((event) => event.type === "run.failed")).toBe(true);
  });

  it("executes eligible tool calls in parallel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-parallel-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      maxIterations: 2,
    });
    const config = AgentConfig.fromYaml(configPath);

    const order: string[] = [];
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    const toolA = new Tool({
      name: "tool_a",
      description: "tool a",
      inputSchema: {
        type: "object",
        properties: {},
      },
      implementation: async () => {
        order.push("a-start");
        await sleep(20);
        order.push("a-end");
        return { ok: "a" };
      },
    });
    const toolB = new Tool({
      name: "tool_b",
      description: "tool b",
      inputSchema: {
        type: "object",
        properties: {},
      },
      implementation: async () => {
        order.push("b-start");
        await sleep(20);
        order.push("b-end");
        return { ok: "b" };
      },
    });
    (config as { tools: Tool[] }).tools = [toolA, toolB];

    let step = 0;
    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "call parallel",
              tool_calls: [
                { id: "a", name: "tool_a", arguments: {} },
                { id: "b", name: "tool_b", arguments: {} },
              ],
            };
          }
          return {
            content: "done",
          };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "parallel",
    });

    expect(result.status).toBe("completed");
    const firstEndIndex = order.findIndex((item) => item.endsWith("-end"));
    expect(firstEndIndex).toBeGreaterThan(1);
    expect(order.slice(0, firstEndIndex)).toContain("a-start");
    expect(order.slice(0, firstEndIndex)).toContain("b-start");
  });

  it("keeps sequential execution when a tool disables parallel mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-executor-serial-"));
    buildToolYaml(dir);
    const configPath = buildAgentYaml(dir, {
      maxIterations: 2,
    });
    const config = AgentConfig.fromYaml(configPath);

    const order: string[] = [];
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    const toolA = new Tool({
      name: "tool_a",
      description: "tool a",
      inputSchema: {
        type: "object",
        properties: {},
      },
      implementation: async () => {
        order.push("a-start");
        await sleep(10);
        order.push("a-end");
        return { ok: "a" };
      },
      disableParallel: true,
    });
    const toolB = new Tool({
      name: "tool_b",
      description: "tool b",
      inputSchema: {
        type: "object",
        properties: {},
      },
      implementation: async () => {
        order.push("b-start");
        await sleep(10);
        order.push("b-end");
        return { ok: "b" };
      },
    });
    (config as { tools: Tool[] }).tools = [toolA, toolB];

    let step = 0;
    const executor = new AgentExecutor({
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "call serial",
              tool_calls: [
                { id: "a", name: "tool_a", arguments: {} },
                { id: "b", name: "tool_b", arguments: {} },
              ],
            };
          }
          return {
            content: "done",
          };
        },
      }),
    });

    const result = await executor.execute({
      agent: config,
      input: "serial",
    });

    expect(result.status).toBe("completed");
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});
