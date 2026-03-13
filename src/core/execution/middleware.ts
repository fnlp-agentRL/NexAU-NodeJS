import type { AgentConfig } from "../agent-config.js";
import type { ChatMessage, ExecutionEvent, ExecutionResult } from "./types.js";

export interface ExecutionMiddlewareContext {
  agent: AgentConfig;
  input: string;
  history: ChatMessage[];
  agentState: Record<string, unknown>;
  recursionDepth: number;
  signal?: AbortSignal;
  traceContext?: {
    userId?: string;
    sessionId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  };
  onEvent?: (event: ExecutionEvent) => void;
}

export type ExecuteCore = (context: ExecutionMiddlewareContext) => Promise<ExecutionResult>;

export type ExecutionMiddleware = (
  context: ExecutionMiddlewareContext,
  next: ExecuteCore,
) => Promise<ExecutionResult>;

export interface HookImportDefinition {
  import: string;
  params?: Record<string, unknown>;
}

export type HookDefinition = string | HookImportDefinition;

function toHookImport(definition: HookDefinition): HookImportDefinition {
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

function normalizeImportKey(raw: string): string {
  return raw.toLowerCase();
}

function getLogStateKey(params: Record<string, unknown>): string {
  const value = params.state_key;
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return "middleware_logs";
}

export function createLoggingMiddleware(params: Record<string, unknown> = {}): ExecutionMiddleware {
  const stateKey = getLogStateKey(params);

  return async (context, next) => {
    const existing = context.agentState[stateKey];
    const logs = Array.isArray(existing) ? (existing as unknown[]) : [];

    logs.push({
      phase: "before",
      input_preview: context.input.slice(0, 120),
      recursion_depth: context.recursionDepth,
    });
    context.agentState[stateKey] = logs;

    try {
      const result = await next(context);
      logs.push({
        phase: "after",
        status: result.status,
        iterations: result.iterations,
      });
      context.agentState[stateKey] = logs;
      return result;
    } catch (error) {
      logs.push({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      context.agentState[stateKey] = logs;
      throw error;
    }
  };
}

export function resolveExecutionMiddlewares(
  definitions: HookDefinition[] | undefined,
): ExecutionMiddleware[] {
  if (!definitions || definitions.length === 0) {
    return [];
  }

  const middlewares: ExecutionMiddleware[] = [];

  for (const definition of definitions) {
    const hookImport = toHookImport(definition);
    const normalized = normalizeImportKey(hookImport.import);

    if (
      normalized.includes("loggingmiddleware") ||
      normalized.includes("hooks:loggingmiddleware") ||
      normalized.includes("create_logging_hook")
    ) {
      middlewares.push(createLoggingMiddleware(hookImport.params));
      continue;
    }

    // Unknown middleware is treated as pass-through so existing YAML configs remain runnable.
    middlewares.push(async (context, next) => next(context));
  }

  return middlewares;
}

export async function runExecutionMiddlewarePipeline(
  middlewares: ExecutionMiddleware[],
  context: ExecutionMiddlewareContext,
  core: ExecuteCore,
): Promise<ExecutionResult> {
  const dispatch = async (
    index: number,
    currentContext: ExecutionMiddlewareContext,
  ): Promise<ExecutionResult> => {
    const middleware = middlewares[index];
    if (!middleware) {
      return core(currentContext);
    }

    return middleware(currentContext, async (nextContext) => dispatch(index + 1, nextContext));
  };

  return dispatch(0, context);
}
