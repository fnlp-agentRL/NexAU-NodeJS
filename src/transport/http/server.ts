import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ExecutionEvent } from "../../core/execution/types.js";
import { RuntimeService, type RuntimeRequest } from "../runtime-service.js";

export interface HttpServerOptions {
  runtime: RuntimeService;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf-8").trim();
  if (body.length === 0) {
    return {};
  }

  return JSON.parse(body) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function writeSseEvent(
  response: ServerResponse,
  name: string,
  payload: Record<string, unknown>,
): void {
  response.write(`event: ${name}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeRuntimeRequest(body: Record<string, unknown>): RuntimeRequest {
  return {
    input: typeof body.input === "string" ? body.input : "",
    user_id: typeof body.user_id === "string" ? body.user_id : undefined,
    session_id: typeof body.session_id === "string" ? body.session_id : undefined,
    history: Array.isArray(body.history) ? (body.history as RuntimeRequest["history"]) : undefined,
  };
}

function attachRequestAbortSignal(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  request.once("aborted", abort);
  request.once("close", abort);

  return controller.signal;
}

export function createHttpServer(options: HttpServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = request.url ?? "/";

      if (method === "GET" && url === "/health") {
        writeJson(response, 200, { status: "ok" });
        return;
      }

      if (method === "GET" && url === "/info") {
        writeJson(response, 200, options.runtime.getInfo());
        return;
      }

      if (method === "POST" && url === "/query") {
        const body = await readJsonBody(request);
        const runtimeRequest = normalizeRuntimeRequest(body);
        runtimeRequest.signal = attachRequestAbortSignal(request);
        const result = await options.runtime.query(runtimeRequest);
        writeJson(response, 200, result);
        return;
      }

      if (method === "POST" && url === "/stream") {
        const body = await readJsonBody(request);
        const runtimeRequest = normalizeRuntimeRequest(body);
        runtimeRequest.signal = attachRequestAbortSignal(request);

        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });

        const onEvent = (event: ExecutionEvent): void => {
          writeSseEvent(response, event.type, event.payload);
        };

        const result = await options.runtime.query(runtimeRequest, onEvent);
        writeSseEvent(response, "result", {
          status: result.status,
          output: result.output,
          iterations: result.iterations,
          stop_tool_name: result.stop_tool_name,
        });
        writeSseEvent(response, "end", { ok: true });
        response.end();
        return;
      }

      writeJson(response, 404, {
        error: "Not Found",
      });
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
