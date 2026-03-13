import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { initializeMcpTools } from "./mcp-client.js";

describe("initializeMcpTools", () => {
  it("discovers MCP tools and calls them through generated Tool wrappers", async () => {
    let initializeCalls = 0;
    let listCalls = 0;
    let toolCalls = 0;

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          method: string;
          params?: Record<string, unknown>;
        };

        if (payload.method === "initialize") {
          initializeCalls += 1;
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "session-1",
          });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
          return;
        }

        if (payload.method === "tools/list") {
          listCalls += 1;
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
          toolCalls += 1;
          const params = payload.params ?? {};
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const a = Number(args.a ?? 0);
          const b = Number(args.b ?? 0);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              result: {
                value: a + b,
              },
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

    const tools = await initializeMcpTools([
      {
        name: "math-server",
        type: "http",
        url,
      },
    ]);

    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("mcp__math_server__sum");

    const result = await tools[0]!.execute({ a: 2, b: 5 });
    expect(result.server).toBe("math-server");
    expect(result.tool).toBe("sum");
    expect((result.result as Record<string, unknown>).value).toBe(7);

    expect(initializeCalls).toBe(1);
    expect(listCalls).toBe(1);
    expect(toolCalls).toBe(1);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("supports stdio MCP servers with content-length framed JSON-RPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-mcp-stdio-"));
    const scriptPath = join(dir, "fake-mcp-stdio.js");
    writeFileSync(
      scriptPath,
      `
let buffer = Buffer.alloc(0);
function write(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8");
  process.stdout.write(Buffer.concat([header, body]));
}
function handle(msg) {
  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "echo text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false
            }
          }
        ]
      }
    });
    return;
  }
  if (msg.method === "tools/call") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        value: msg.params && msg.params.arguments ? msg.params.arguments.text : ""
      }
    });
    return;
  }
  write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
function consume() {
  while (true) {
    const sep = buffer.indexOf("\\r\\n\\r\\n");
    if (sep < 0) return;
    const header = buffer.subarray(0, sep).toString("utf8");
    const line = header.split("\\r\\n").find((x) => x.toLowerCase().startsWith("content-length:"));
    if (!line) {
      buffer = buffer.subarray(sep + 4);
      continue;
    }
    const len = Number(line.split(":")[1].trim());
    const start = sep + 4;
    const end = start + len;
    if (buffer.length < end) return;
    const body = buffer.subarray(start, end).toString("utf8");
    buffer = buffer.subarray(end);
    try {
      const msg = JSON.parse(body);
      handle(msg);
    } catch {}
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  consume();
});
`,
    );

    const tools = await initializeMcpTools([
      {
        name: "stdio-server",
        type: "stdio",
        command: process.execPath,
        args: [scriptPath],
        timeout: 10,
      },
    ]);

    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("mcp__stdio_server__echo");

    const result = await tools[0]!.execute({ text: "hello-stdio" });
    expect(result.server).toBe("stdio-server");
    expect(result.tool).toBe("echo");
    expect((result.result as Record<string, unknown>).value).toBe("hello-stdio");
  });
});
