import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { AgentConfig } from "../../core/agent-config.js";
import { Agent } from "../../core/agent.js";
import { handleStdioRequest, startStdioServer } from "./server.js";
import { RuntimeService } from "../runtime-service.js";

function createConfig(dir: string): string {
  const toolPath = join(dir, "write_todos.tool.yaml");
  writeFileSync(
    toolPath,
    [
      "type: tool",
      "name: write_todos",
      "description: write todos",
      "input_schema:",
      "  type: object",
      "  properties:",
      "    todos:",
      "      type: array",
      "  required:",
      "    - todos",
      "  additionalProperties: false",
    ].join("\n"),
  );

  const path = join(dir, "agent.yaml");
  writeFileSync(
    path,
    [
      "type: agent",
      "name: stdio_test_agent",
      "llm_config:",
      "  model: t",
      "  base_url: https://example.com/v1",
      "  api_key: t",
      "tools:",
      "  - name: write_todos",
      "    yaml_path: ./write_todos.tool.yaml",
      "    binding: nexau.archs.tool.builtin.session_tools:write_todos",
    ].join("\n"),
  );
  return path;
}

describe("STDIO transport", () => {
  it("supports health/info/query/stream methods", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-stdio-e2e-"));
    const configPath = createConfig(dir);
    const config = AgentConfig.fromYaml(configPath);

    let calls = 0;
    let sawDynamicPrompt = false;
    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete(input) {
          const systemMessage = input.messages.find((message) => message.role === "system");
          if ((systemMessage?.content ?? "").includes("stdio dynamic prompt")) {
            sawDynamicPrompt = true;
          }
          if (calls === 0) {
            calls += 1;
            return {
              content: "tool first",
              tool_calls: [
                {
                  id: "a1",
                  name: "write_todos",
                  arguments: { todos: [{ description: "x", status: "pending" }] },
                },
              ],
            };
          }
          return { content: "stdio done" };
        },
      }),
    });

    const runtime = new RuntimeService(agent);
    const outputs: Array<Record<string, unknown>> = [];

    await handleStdioRequest(runtime, { id: "h", method: "health" }, (payload) =>
      outputs.push(payload),
    );
    await handleStdioRequest(runtime, { id: "i", method: "info" }, (payload) =>
      outputs.push(payload),
    );
    await handleStdioRequest(
      runtime,
      {
        id: "q",
        method: "query",
        params: {
          input: "hello",
          system_prompt_addition: "stdio dynamic prompt",
        },
      },
      (payload) => outputs.push(payload),
    );

    calls = 0;
    await handleStdioRequest(
      runtime,
      {
        id: "s",
        method: "stream",
        params: { input: "stream" },
      },
      (payload) => outputs.push(payload),
    );

    expect(outputs.find((item) => item.id === "h" && item.type === "result")).toBeTruthy();
    expect(outputs.find((item) => item.id === "i" && item.type === "result")).toBeTruthy();

    const queryResult = outputs.find((item) => item.id === "q" && item.type === "result") as {
      result: { output: string };
    };
    expect(queryResult.result.output).toBe("stdio done");
    expect(sawDynamicPrompt).toBe(true);

    const streamEvents = outputs.filter((item) => item.id === "s" && item.type === "event");
    expect(streamEvents.length).toBeGreaterThan(0);

    const streamResult = outputs.find((item) => item.id === "s" && item.type === "result") as {
      result: { output: string };
    };
    expect(streamResult.result.output).toBe("stdio done");
  });

  it("returns error on unknown methods and invalid json lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-stdio-invalid-"));
    const configPath = createConfig(dir);
    const config = AgentConfig.fromYaml(configPath);
    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete() {
          return { content: "ok" };
        },
      }),
    });
    const runtime = new RuntimeService(agent);

    const outputs: Array<Record<string, unknown>> = [];
    await handleStdioRequest(runtime, { id: "u", method: "unknown" }, (payload) =>
      outputs.push(payload),
    );
    expect(outputs[0]?.type).toBe("error");

    const input = new PassThrough();
    const output = new PassThrough();
    const outputChunks: string[] = [];
    output.on("data", (chunk) => outputChunks.push(String(chunk)));

    startStdioServer({ runtime, input, output });
    input.end("not-json\\n");
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(outputChunks.join("")).toContain("Invalid JSON input");

    const throwingRuntime = {
      query: async () => {
        throw new Error("query failed");
      },
      getInfo: () => ({ name: "x" }),
    } as unknown as RuntimeService;
    const thrownOutputs: Array<Record<string, unknown>> = [];
    await handleStdioRequest(
      throwingRuntime,
      { id: "qf", method: "query", params: { input: "x" } },
      (payload) => thrownOutputs.push(payload),
    );
    expect(thrownOutputs[0]?.type).toBe("error");
    expect(String((thrownOutputs[0]?.error as { message?: string })?.message)).toContain(
      "query failed",
    );
  });
});
