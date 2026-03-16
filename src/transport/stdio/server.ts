import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { ExecutionEvent } from "../../core/execution/types.js";
import { RuntimeService, type RuntimeRequest } from "../runtime-service.js";

interface StdioRequest {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

interface StdioServerOptions {
  runtime: RuntimeService;
  input?: Readable;
  output?: Writable;
}

function writeJsonLine(output: Writable, payload: Record<string, unknown>): void {
  output.write(`${JSON.stringify(payload)}\n`);
}

function normalizeRuntimeRequest(params: Record<string, unknown>): RuntimeRequest {
  return {
    input: typeof params.input === "string" ? params.input : "",
    user_id: typeof params.user_id === "string" ? params.user_id : undefined,
    session_id: typeof params.session_id === "string" ? params.session_id : undefined,
    system_prompt_addition:
      typeof params.system_prompt_addition === "string" ? params.system_prompt_addition : undefined,
    history: Array.isArray(params.history)
      ? (params.history as RuntimeRequest["history"])
      : undefined,
  };
}

export async function handleStdioRequest(
  runtime: RuntimeService,
  request: StdioRequest,
  write: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const id = request.id ?? null;

  try {
    switch (request.method) {
      case "health": {
        write({ id, type: "result", result: { status: "ok" } });
        return;
      }
      case "info": {
        write({ id, type: "result", result: runtime.getInfo() });
        return;
      }
      case "query": {
        const params = request.params ?? {};
        const result = await runtime.query(normalizeRuntimeRequest(params));
        write({ id, type: "result", result });
        return;
      }
      case "stream": {
        const params = request.params ?? {};
        const onEvent = (event: ExecutionEvent): void => {
          write({ id, type: "event", event });
        };
        const result = await runtime.query(normalizeRuntimeRequest(params), onEvent);
        write({ id, type: "result", result });
        return;
      }
      default: {
        write({
          id,
          type: "error",
          error: {
            message: `Unknown method: ${String(request.method ?? "")}`,
          },
        });
      }
    }
  } catch (error) {
    write({
      id,
      type: "error",
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function startStdioServer(options: StdioServerOptions): void {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    let parsed: StdioRequest;
    try {
      parsed = JSON.parse(line) as StdioRequest;
    } catch {
      writeJsonLine(output, {
        id: null,
        type: "error",
        error: {
          message: "Invalid JSON input",
        },
      });
      return;
    }

    void handleStdioRequest(options.runtime, parsed, (payload) => {
      writeJsonLine(output, payload);
    });
  });
}
