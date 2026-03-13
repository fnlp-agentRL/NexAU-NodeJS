import { InMemoryTracer } from "./adapters/in-memory.js";
import { LangfuseTracer } from "./adapters/langfuse.js";
import type { ExecutionTracer } from "./base.js";
import { CompositeTracer } from "./composite.js";

export type TracerHookDefinition = string | { import: string; params?: Record<string, unknown> };

function asDefinition(definition: TracerHookDefinition): {
  import: string;
  params: Record<string, unknown>;
} {
  if (typeof definition === "string") {
    return {
      import: definition,
      params: {},
    };
  }
  return {
    import: definition.import,
    params: definition.params ?? {},
  };
}

function normalizeImportName(name: string): string {
  return name.toLowerCase();
}

function toLangfuseTracer(params: Record<string, unknown>): ExecutionTracer {
  return new LangfuseTracer({
    publicKey: typeof params.public_key === "string" ? params.public_key : undefined,
    secretKey: typeof params.secret_key === "string" ? params.secret_key : undefined,
    host: typeof params.host === "string" ? params.host : undefined,
    enabled: typeof params.enabled === "boolean" ? params.enabled : true,
  });
}

export function resolveTracer(
  definitions: TracerHookDefinition[] | undefined,
): ExecutionTracer | null {
  if (!definitions || definitions.length === 0) {
    return null;
  }

  const tracers: ExecutionTracer[] = [];

  for (const rawDefinition of definitions) {
    const definition = asDefinition(rawDefinition);
    const importName = normalizeImportName(definition.import);

    if (importName.includes("langfuse")) {
      tracers.push(toLangfuseTracer(definition.params));
      continue;
    }

    if (importName.includes("in_memory") || importName.includes("inmemory")) {
      tracers.push(new InMemoryTracer());
      continue;
    }
  }

  if (tracers.length === 0) {
    return null;
  }

  if (tracers.length === 1) {
    return tracers[0]!;
  }

  return new CompositeTracer(tracers);
}
