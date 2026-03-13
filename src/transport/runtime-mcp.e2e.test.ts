import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentConfig } from "../core/agent-config.js";
import { Agent } from "../core/agent.js";
import { RuntimeService } from "./runtime-service.js";

function createMcpConfig(dir: string, mcpUrl: string): string {
  const filePath = join(dir, "mcp-agent.yaml");
  writeFileSync(
    filePath,
    [
      "type: agent",
      "name: runtime_mcp_agent",
      "llm_config:",
      "  model: test-model",
      "  base_url: https://example.com/v1",
      "  api_key: test-key",
      "mcp_servers:",
      "  - name: local-mcp",
      "    type: http",
      `    url: ${mcpUrl}`,
    ].join("\n"),
  );
  return filePath;
}

describe("RuntimeService MCP smoke", () => {
  it("completes llm -> mcp tool -> llm flow", async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          method: string;
          params?: Record<string, unknown>;
        };
        if (payload.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
          return;
        }
        if (payload.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: {
                tools: [
                  {
                    name: "sum",
                    description: "sum two numbers",
                    inputSchema: {
                      type: "object",
                      properties: {
                        a: { type: "number" },
                        b: { type: "number" },
                      },
                      required: ["a", "b"],
                      additionalProperties: false,
                    },
                  },
                ],
              },
            }),
          );
          return;
        }
        if (payload.method === "tools/call") {
          const params = payload.params ?? {};
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const a = Number(args.a ?? 0);
          const b = Number(args.b ?? 0);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { value: a + b } }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind mcp test server");
    }

    const dir = mkdtempSync(join(tmpdir(), "nexau-runtime-mcp-e2e-"));
    const configPath = createMcpConfig(dir, `http://127.0.0.1:${address.port}/mcp`);
    const config = AgentConfig.fromYaml(configPath);

    let step = 0;
    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "call mcp",
              tool_calls: [
                {
                  id: "mcp-call-1",
                  name: "mcp__local_mcp__sum",
                  arguments: { a: 10, b: 5 },
                },
              ],
            };
          }
          return { content: "15" };
        },
      }),
    });

    const runtime = new RuntimeService(agent);
    const result = await runtime.query({
      input: "compute",
      user_id: "u1",
      session_id: "s1",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("15");
    expect(result.events.some((event) => event.type === "tool.called")).toBe(true);
    expect(result.events.some((event) => event.type === "tool.completed")).toBe(true);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
});
