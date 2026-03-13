import type { ExecutionEvent } from "../core/execution/types.js";
import type { ExecutionTracer, TraceRunEnd, TraceRunStart } from "./base.js";

async function callSafely(operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Best-effort tracer fan-out should not fail agent execution.
  }
}

export class CompositeTracer implements ExecutionTracer {
  private readonly tracers: ExecutionTracer[];

  public constructor(tracers: ExecutionTracer[]) {
    this.tracers = tracers;
  }

  public async startRun(input: TraceRunStart): Promise<void> {
    await Promise.all(this.tracers.map((tracer) => callSafely(() => tracer.startRun(input))));
  }

  public async onEvent(input: TraceRunStart, event: ExecutionEvent): Promise<void> {
    await Promise.all(this.tracers.map((tracer) => callSafely(() => tracer.onEvent(input, event))));
  }

  public async endRun(input: TraceRunEnd): Promise<void> {
    await Promise.all(this.tracers.map((tracer) => callSafely(() => tracer.endRun(input))));
  }

  public async flush(): Promise<void> {
    await Promise.all(
      this.tracers.map((tracer) =>
        callSafely(() => {
          if (tracer.flush) {
            return tracer.flush();
          }
        }),
      ),
    );
  }

  public async shutdown(): Promise<void> {
    await Promise.all(
      this.tracers.map((tracer) =>
        callSafely(() => {
          if (tracer.shutdown) {
            return tracer.shutdown();
          }
        }),
      ),
    );
  }
}
