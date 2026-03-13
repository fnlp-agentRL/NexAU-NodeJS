import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentConfig } from "../../core/agent-config.js";
import { Agent } from "../../core/agent.js";
import { RuntimeService } from "../../transport/runtime-service.js";
import { runServeStdioCommand } from "./serve-stdio.js";

describe("runServeStdioCommand", () => {
  it("starts stdio server with injected streams", async () => {
    const config = {
      name: "serve_stdio_test",
      llm_config: {
        model: "t",
        base_url: "https://example.com/v1",
        api_key: "t",
        api_type: "openai_chat_completion",
        extra_params: {},
      },
      max_iterations: 2,
      max_context_tokens: 1000,
      tools: [],
      stop_tools: new Set<string>(),
    } as unknown as AgentConfig;

    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete() {
          return { content: "stdio ok" };
        },
      }),
    });
    const runtime = new RuntimeService(agent);

    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => {
      chunks.push(String(chunk));
    });

    runServeStdioCommand({
      config: "unused",
      runtime,
      input,
      output,
    });

    input.write(`${JSON.stringify({ id: "x", method: "health" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(chunks.join("")).toContain('"id":"x"');
    expect(chunks.join("")).toContain('"status":"ok"');
  });

  it("builds runtime from config when runtime is not provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-serve-stdio-default-"));
    const configPath = join(dir, "agent.yaml");
    writeFileSync(
      configPath,
      [
        "type: agent",
        "name: serve_stdio_default",
        "llm_config:",
        "  model: t",
        "  base_url: https://example.com/v1",
        "  api_key: t",
      ].join("\n"),
    );

    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => {
      chunks.push(String(chunk));
    });

    runServeStdioCommand({
      config: configPath,
      input,
      output,
    });

    input.write(`${JSON.stringify({ id: "d", method: "health" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunks.join("")).toContain('"id":"d"');
  });
});
