import type { ExecutionEvent } from "../../core/execution/types.js";
import type { ExecutionTracer, TraceRunEnd, TraceRunStart } from "../base.js";

export interface InMemoryTraceRecord {
  run: TraceRunStart;
  events: ExecutionEvent[];
  result?: TraceRunEnd["result"];
}

export class InMemoryTracer implements ExecutionTracer {
  private readonly records = new Map<string, InMemoryTraceRecord>();

  public getRun(runId: string): InMemoryTraceRecord | undefined {
    return this.records.get(runId);
  }

  public getAllRuns(): InMemoryTraceRecord[] {
    return [...this.records.values()];
  }

  public startRun(input: TraceRunStart): void {
    this.records.set(input.runId, {
      run: input,
      events: [],
    });
  }

  public onEvent(input: TraceRunStart, event: ExecutionEvent): void {
    const record = this.records.get(input.runId);
    if (!record) {
      this.startRun(input);
      this.onEvent(input, event);
      return;
    }
    record.events.push(event);
  }

  public endRun(input: TraceRunEnd): void {
    const record = this.records.get(input.runId);
    if (!record) {
      this.records.set(input.runId, {
        run: input,
        events: [],
        result: input.result,
      });
      return;
    }
    record.result = input.result;
  }
}
