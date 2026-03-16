import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentConfig } from "../../core/agent-config.js";
import { Agent } from "../../core/agent.js";
import { createHttpServer } from "./server.js";
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
      "name: http_test_agent",
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

describe("HTTP transport", () => {
  const servers: Array<import("node:http").Server> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (!server) {
        continue;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("supports health, info, query and stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-http-e2e-"));
    const configPath = createConfig(dir);
    const config = AgentConfig.fromYaml(configPath);

    let calls = 0;
    let capturedSystemPrompt = "";
    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete(input) {
          const systemMessage = input.messages.find((message) => message.role === "system");
          capturedSystemPrompt = systemMessage?.content ?? "";
          if (calls === 0) {
            calls += 1;
            return {
              content: "using tool",
              tool_calls: [
                {
                  id: "t1",
                  name: "write_todos",
                  arguments: { todos: [{ description: "a", status: "pending" }] },
                },
              ],
            };
          }
          return { content: "final output" };
        },
      }),
    });

    const runtime = new RuntimeService(agent);
    const server = createHttpServer({ runtime });
    servers.push(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to get bound address");
    }

    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const info = await fetch(`${base}/info`);
    expect(info.status).toBe(200);
    const infoJson = (await info.json()) as Record<string, unknown>;
    expect(infoJson.name).toBe("http_test_agent");

    const query = await fetch(`${base}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "hello",
        system_prompt_addition: "http dynamic prompt",
      }),
    });
    expect(query.status).toBe(200);
    const queryJson = (await query.json()) as Record<string, unknown>;
    expect(queryJson.output).toBe("final output");
    expect(capturedSystemPrompt).toContain("http dynamic prompt");

    calls = 0;
    const stream = await fetch(`${base}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "stream please" }),
    });
    expect(stream.status).toBe(200);
    const streamText = await stream.text();
    expect(streamText).toContain("event: run.started");
    expect(streamText).toContain("event: tool.completed");
    expect(streamText).toContain("event: result");

    const notFound = await fetch(`${base}/missing`);
    expect(notFound.status).toBe(404);

    const badJson = await fetch(`${base}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad-json}",
    });
    expect(badJson.status).toBe(500);
  });
});
