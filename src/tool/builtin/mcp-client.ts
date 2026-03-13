import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { Tool } from "../tool.js";

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpServerConfig {
  name: string;
  type: "http" | "stdio";
  url?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  timeoutSeconds: number;
}

interface JsonRpcSuccess {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
}

function toStringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") {
      output[key] = value;
    }
  }
  return output;
}

function parseServerConfig(raw: unknown, index: number): McpServerConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const typed = raw as Record<string, unknown>;
  const name = typeof typed.name === "string" ? typed.name.trim() : "";
  if (!name) {
    return null;
  }

  const type = typed.type === "stdio" ? "stdio" : "http";
  const timeoutRaw = typed.timeout;
  const timeoutSeconds =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? timeoutRaw
      : 30;

  const headers = toStringMap(typed.headers);
  const url = typeof typed.url === "string" ? typed.url : undefined;
  const command = typeof typed.command === "string" ? typed.command : undefined;
  const args = Array.isArray(typed.args)
    ? typed.args.filter((item): item is string => typeof item === "string")
    : [];
  const env = toStringMap(typed.env);

  const config: McpServerConfig = {
    name: `${name || `server-${index}`}`,
    type,
    url,
    command,
    args,
    env,
    headers,
    timeoutSeconds,
  };
  return config;
}

function sanitizeName(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_]/g, "_");
}

function ensureObjectSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }
  const typed = schema as Record<string, unknown>;
  if (typed.type === "object") {
    return typed;
  }
  return {
    type: "object",
    properties: (typed.properties as Record<string, unknown>) ?? {},
    required: (typed.required as unknown[]) ?? [],
    additionalProperties:
      typeof typed.additionalProperties === "boolean" ? typed.additionalProperties : true,
  };
}

function extractTools(result: Record<string, unknown> | undefined): McpToolDefinition[] {
  if (!result) {
    return [];
  }

  const toolsRaw = Array.isArray(result.tools) ? result.tools : [];
  const tools: McpToolDefinition[] = [];

  for (const item of toolsRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const tool = item as Record<string, unknown>;
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      continue;
    }

    const inputSchema =
      (tool.inputSchema as Record<string, unknown> | undefined) ??
      (tool.input_schema as Record<string, unknown> | undefined);

    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: inputSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    });
  }

  return tools;
}

class McpHttpClient {
  private readonly server: McpServerConfig;
  private sessionId: string | null = null;
  private initialized = false;

  public constructor(server: McpServerConfig) {
    this.server = server;
  }

  private async callRpc(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<JsonRpcSuccess> {
    if (!this.server.url) {
      throw new Error(`MCP server '${this.server.name}' has no URL`);
    }

    const body = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.server.headers,
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const response = await fetch(this.server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.server.timeoutSeconds * 1000),
    });
    const maybeSessionId = response.headers.get("mcp-session-id");
    if (maybeSessionId) {
      this.sessionId = maybeSessionId;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MCP ${method} failed (${response.status}): ${text}`);
    }

    return (await response.json()) as JsonRpcSuccess;
  }

  public async initializeIfNeeded(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.callRpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "nexau-nodejs",
          version: "0.1.0",
        },
      });
    } catch {
      // Some servers allow tools/list without explicit initialize.
    }
    this.initialized = true;
  }

  public async listTools(): Promise<McpToolDefinition[]> {
    await this.initializeIfNeeded();
    const result = await this.callRpc("tools/list", {});
    return extractTools(result.result);
  }

  public async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.initializeIfNeeded();
    const result = await this.callRpc("tools/call", {
      name: toolName,
      arguments: args,
    });

    const payload = (result.result ?? {}) as Record<string, unknown>;
    return {
      server: this.server.name,
      tool: toolName,
      result: payload,
    };
  }
}

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

function normalizeRpcId(id: unknown): string | null {
  if (typeof id === "string") {
    return id;
  }
  if (typeof id === "number") {
    return String(id);
  }
  return null;
}

function parseContentLengthHeader(header: string): number | null {
  const lines = header.split("\r\n");
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) {
      continue;
    }
    if (rawKey.trim().toLowerCase() !== "content-length") {
      continue;
    }
    const value = Number(rest.join(":").trim());
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

class McpStdioClient {
  private readonly server: McpServerConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    string,
    {
      resolve: (value: JsonRpcSuccess) => void;
      reject: (error: Error) => void;
      timeoutId: NodeJS.Timeout;
    }
  >();

  public constructor(server: McpServerConfig) {
    this.server = server;
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    if (!this.server.command) {
      throw new Error(`MCP stdio server '${this.server.name}' has no command`);
    }

    const child = spawn(this.server.command, this.server.args, {
      stdio: "pipe",
      env: {
        ...process.env,
        ...this.server.env,
      },
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.consumeFrames();
    });

    child.on("exit", () => {
      const error = new Error(`MCP stdio server '${this.server.name}' exited`);
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timeoutId);
        entry.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.initialized = false;
      this.buffer = Buffer.alloc(0);
    });

    this.child = child;
    return child;
  }

  private consumeFrames(): void {
    while (true) {
      const headerEndIndex = this.buffer.indexOf("\r\n\r\n");
      if (headerEndIndex < 0) {
        return;
      }
      const header = this.buffer.subarray(0, headerEndIndex).toString("utf-8");
      const contentLength = parseContentLengthHeader(header);
      if (contentLength === null) {
        this.buffer = this.buffer.subarray(headerEndIndex + 4);
        continue;
      }
      const frameStart = headerEndIndex + 4;
      const frameEnd = frameStart + contentLength;
      if (this.buffer.length < frameEnd) {
        return;
      }

      const payload = this.buffer.subarray(frameStart, frameEnd).toString("utf-8");
      this.buffer = this.buffer.subarray(frameEnd);

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }

      const id = normalizeRpcId(parsed.id);
      if (!id) {
        continue;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        continue;
      }
      this.pending.delete(id);
      clearTimeout(pending.timeoutId);

      if ("error" in parsed && parsed.error && typeof parsed.error === "object") {
        const rpcError = parsed.error as JsonRpcError;
        pending.reject(
          new Error(
            `MCP RPC error (${rpcError.code ?? "unknown"}): ${rpcError.message ?? "unknown"}`,
          ),
        );
        continue;
      }

      pending.resolve(parsed as JsonRpcSuccess);
    }
  }

  private async callRpc(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<JsonRpcSuccess> {
    const child = this.ensureProcess();
    const id = randomUUID();
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const body = JSON.stringify(message);
    const framed = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;

    const response = await new Promise<JsonRpcSuccess>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${this.server.timeoutSeconds}s`));
      }, this.server.timeoutSeconds * 1000);
      timeoutId.unref?.();

      this.pending.set(id, { resolve, reject, timeoutId });
      child.stdin.write(framed, "utf-8", (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(error);
      });
    });

    return response;
  }

  public async initializeIfNeeded(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      await this.callRpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "nexau-nodejs",
          version: "0.1.0",
        },
      });
    } catch {
      // Some servers allow tools/list without explicit initialize.
    }
    this.initialized = true;
  }

  public async listTools(): Promise<McpToolDefinition[]> {
    await this.initializeIfNeeded();
    const result = await this.callRpc("tools/list", {});
    return extractTools(result.result);
  }

  public async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.initializeIfNeeded();
    const result = await this.callRpc("tools/call", {
      name: toolName,
      arguments: args,
    });
    const payload = (result.result ?? {}) as Record<string, unknown>;
    return {
      server: this.server.name,
      tool: toolName,
      result: payload,
    };
  }
}

type McpClient = {
  listTools: () => Promise<McpToolDefinition[]>;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

async function buildToolsForServer(server: McpServerConfig): Promise<Tool[]> {
  let client: McpClient | null = null;
  if (server.type === "http" && server.url) {
    client = new McpHttpClient(server);
  } else if (server.type === "stdio" && server.command) {
    client = new McpStdioClient(server);
  }

  if (!client) {
    return [];
  }

  const listedTools = await client.listTools();
  const built: Tool[] = [];

  for (const listedTool of listedTools) {
    const localName = `mcp__${sanitizeName(server.name)}__${sanitizeName(listedTool.name)}`;
    const schema = ensureObjectSchema(listedTool.inputSchema);
    built.push(
      new Tool({
        name: localName,
        description: listedTool.description || `[MCP ${server.name}] ${listedTool.name}`,
        inputSchema: schema,
        implementation: async (params) => client.callTool(listedTool.name, params),
      }),
    );
  }

  return built;
}

export async function initializeMcpTools(serverConfigs: unknown[]): Promise<Tool[]> {
  if (!Array.isArray(serverConfigs) || serverConfigs.length === 0) {
    return [];
  }

  const servers = serverConfigs
    .map((item, index) => parseServerConfig(item, index))
    .filter((item): item is McpServerConfig => item !== null);

  const toolsByServer = await Promise.all(
    servers.map(async (server) => {
      try {
        return await buildToolsForServer(server);
      } catch {
        return [];
      }
    }),
  );

  return toolsByServer.flat();
}
