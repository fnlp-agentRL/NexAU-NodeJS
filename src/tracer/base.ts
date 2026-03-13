import type { ExecutionEvent, ExecutionResult } from "../core/execution/types.js";

export interface TraceRunStart {
  runId: string;
  agentName: string;
  input: string;
  recursionDepth: number;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface TraceRunEnd extends TraceRunStart {
  result: ExecutionResult;
}

export interface ExecutionTracer {
  startRun(input: TraceRunStart): void | Promise<void>;
  onEvent(input: TraceRunStart, event: ExecutionEvent): void | Promise<void>;
  endRun(input: TraceRunEnd): void | Promise<void>;
  flush?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

export class NoopTracer implements ExecutionTracer {
  public startRun(): void {}

  public onEvent(): void {}

  public endRun(): void {}
}
