import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentConfig } from "./agent-config.js";
import { Agent } from "./agent.js";

function createMcpAgentYaml(dir: string, mcpUrl: string): string {
  const filePath = join(dir, "agent.yaml");
  writeFileSync(
    filePath,
    [
      "type: agent",
      "name: mcp_agent",
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

describe("Agent MCP integration", () => {
  it("loads MCP tools before run and exposes them to LLM tool list", async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { method: string };
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
                    name: "echo",
                    description: "echo text",
                    inputSchema: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                      },
                      required: ["text"],
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
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { ok: true } }));
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
      throw new Error("failed to bind server");
    }
    const url = `http://127.0.0.1:${address.port}/mcp`;

    const dir = mkdtempSync(join(tmpdir(), "nexau-agent-mcp-"));
    const configPath = createMcpAgentYaml(dir, url);
    const config = AgentConfig.fromYaml(configPath);

    const seenToolNames: string[] = [];
    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete(input) {
          const names = input.tools
            .map((item) => {
              if (!item || typeof item !== "object") {
                return "";
              }
              const fn = (item as { function?: { name?: unknown } }).function;
              return typeof fn?.name === "string" ? fn.name : "";
            })
            .filter((name) => name.length > 0);
          seenToolNames.push(...names);

          return {
            content: "ok",
          };
        },
      }),
    });

    const result = await agent.run("hello");
    expect(result.status).toBe("completed");
    expect(seenToolNames).toContain("mcp__local_mcp__echo");

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("runs MCP tool through llm -> tool -> llm loop", async () => {
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
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              result: { value: a + b },
            }),
          );
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
      throw new Error("failed to bind server");
    }
    const url = `http://127.0.0.1:${address.port}/mcp`;

    const dir = mkdtempSync(join(tmpdir(), "nexau-agent-mcp-loop-"));
    const configPath = createMcpAgentYaml(dir, url);
    const config = AgentConfig.fromYaml(configPath);

    let step = 0;
    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "calling mcp",
              tool_calls: [
                {
                  id: "call-mcp-1",
                  name: "mcp__local_mcp__sum",
                  arguments: {
                    a: 2,
                    b: 3,
                  },
                },
              ],
            };
          }
          return {
            content: "sum is 5",
          };
        },
      }),
    });

    const result = await agent.run("what is 2+3?");
    expect(result.status).toBe("completed");
    expect(result.output).toBe("sum is 5");
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
});
