import type { ExecutionEvent } from "../../core/execution/types.js";
import type { ExecutionTracer, TraceRunEnd, TraceRunStart } from "../base.js";

interface LangfuseTracerOptions {
  publicKey?: string;
  secretKey?: string;
  host?: string;
  enabled?: boolean;
}

interface RunBuffer {
  run: TraceRunStart;
  events: ExecutionEvent[];
}

function normalizeHost(host: string): string {
  return host.endsWith("/") ? host.slice(0, -1) : host;
}

function toIsoDate(value: Date): string {
  return value.toISOString();
}

function safeMetadata(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) {
    return {};
  }
  return { ...input };
}

export class LangfuseTracer implements ExecutionTracer {
  private readonly enabled: boolean;
  private readonly publicKey: string;
  private readonly secretKey: string;
  private readonly host: string;
  private readonly runs = new Map<string, RunBuffer>();

  public constructor(options: LangfuseTracerOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.publicKey = options.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY ?? "";
    this.secretKey = options.secretKey ?? process.env.LANGFUSE_SECRET_KEY ?? "";
    this.host = normalizeHost(
      options.host ?? process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
    );
  }

  public startRun(input: TraceRunStart): void {
    this.runs.set(input.runId, {
      run: input,
      events: [],
    });
  }

  public onEvent(input: TraceRunStart, event: ExecutionEvent): void {
    const buffer = this.runs.get(input.runId);
    if (!buffer) {
      this.startRun(input);
      this.onEvent(input, event);
      return;
    }
    buffer.events.push(event);
  }

  public async endRun(input: TraceRunEnd): Promise<void> {
    const buffer = this.runs.get(input.runId) ?? {
      run: input,
      events: [],
    };
    this.runs.delete(input.runId);

    if (!this.enabled || !this.publicKey || !this.secretKey) {
      return;
    }

    const now = new Date();
    const batch = {
      batch: [
        {
          id: `${input.runId}-trace`,
          type: "trace-create",
          timestamp: toIsoDate(now),
          body: {
            id: input.runId,
            name: input.agentName,
            input: buffer.run.input,
            output: input.result.output,
            userId: input.userId,
            sessionId: input.sessionId,
            metadata: {
              recursionDepth: input.recursionDepth,
              status: input.result.status,
              iterations: input.result.iterations,
              tags: input.tags ?? [],
              custom: safeMetadata(input.metadata),
              events: buffer.events.map((event) => ({
                type: event.type,
                payload: event.payload,
              })),
            },
          },
        },
      ],
    };

    const credentials = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64");
    const response = await fetch(`${this.host}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Langfuse ingestion failed (${response.status}): ${body}`);
    }
  }
}
