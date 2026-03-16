import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentConfig } from "../agent-config.js";
import type { ChatMessage, ExecutionEvent, ExecutionResult } from "./types.js";

export interface ExecutionMiddlewareContext {
  agent: AgentConfig;
  input: string;
  history: ChatMessage[];
  systemPromptAddition?: string;
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

const PASSTHROUGH_MIDDLEWARE: ExecutionMiddleware = async (context, next) => next(context);

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

function parseImportSpecifier(raw: string): {
  moduleSpecifier: string;
  exportName?: string;
} {
  const normalized = raw.trim();
  const colonIndex = normalized.lastIndexOf(":");
  if (colonIndex <= 0) {
    return { moduleSpecifier: normalized };
  }

  // Keep compatibility with Python-style `module.path:ExportName` while not
  // breaking URL prefixes such as `file://`.
  if (normalized.startsWith("file://") && colonIndex <= "file://".length) {
    return { moduleSpecifier: normalized };
  }

  const exportName = normalized.slice(colonIndex + 1);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) {
    return { moduleSpecifier: normalized };
  }

  return {
    moduleSpecifier: normalized.slice(0, colonIndex),
    exportName,
  };
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function buildImportCandidates(moduleSpecifier: string): string[] {
  const candidates: string[] = [];

  if (moduleSpecifier.startsWith("file://")) {
    pushUnique(candidates, moduleSpecifier);
    return candidates;
  }

  if (moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")) {
    const absPath = isAbsolute(moduleSpecifier)
      ? moduleSpecifier
      : resolve(process.cwd(), moduleSpecifier);
    if (existsSync(absPath)) {
      pushUnique(candidates, pathToFileURL(absPath).href);
    } else {
      for (const ext of [".js", ".mjs", ".cjs", ".ts"]) {
        const withExt = `${absPath}${ext}`;
        if (existsSync(withExt)) {
          pushUnique(candidates, pathToFileURL(withExt).href);
        }
      }
    }
    return candidates;
  }

  pushUnique(candidates, moduleSpecifier);

  // Compatibility helper for Python-style dotted import paths.
  if (moduleSpecifier.includes(".") && !moduleSpecifier.includes("/")) {
    pushUnique(candidates, moduleSpecifier.replaceAll(".", "/"));
  }

  return candidates;
}

function isClassConstructor(candidate: unknown): candidate is new (...args: unknown[]) => unknown {
  if (typeof candidate !== "function") {
    return false;
  }
  const source = Function.prototype.toString.call(candidate);
  return source.startsWith("class ");
}

function resolveMiddlewareFromObject(candidate: unknown): ExecutionMiddleware | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const maybeMiddleware = candidate as {
    handle?: unknown;
    middleware?: unknown;
    execute?: unknown;
  };

  if (typeof maybeMiddleware.middleware === "function") {
    return maybeMiddleware.middleware as ExecutionMiddleware;
  }

  if (typeof maybeMiddleware.handle === "function") {
    return async (context, next) =>
      (maybeMiddleware.handle as ExecutionMiddleware).call(candidate, context, next);
  }

  if (typeof maybeMiddleware.execute === "function") {
    return async (context, next) =>
      (maybeMiddleware.execute as ExecutionMiddleware).call(candidate, context, next);
  }

  return null;
}

function materializeMiddleware(
  candidate: unknown,
  params: Record<string, unknown>,
): ExecutionMiddleware | null {
  const fromObject = resolveMiddlewareFromObject(candidate);
  if (fromObject) {
    return fromObject;
  }

  if (typeof candidate !== "function") {
    return null;
  }

  if (isClassConstructor(candidate)) {
    try {
      const instance = new candidate(params);
      return materializeMiddleware(instance, params);
    } catch {
      return null;
    }
  }

  // Two-arg function is treated as a middleware function directly.
  if (candidate.length >= 2) {
    return candidate as ExecutionMiddleware;
  }

  // One-arg/no-arg function is treated as a factory.
  try {
    const produced = (candidate as (params?: Record<string, unknown>) => unknown)(params);
    if (produced === candidate) {
      return null;
    }
    return materializeMiddleware(produced, params);
  } catch {
    return null;
  }
}

async function loadExternalMiddleware(
  hookImport: HookImportDefinition,
): Promise<ExecutionMiddleware | null> {
  const { moduleSpecifier, exportName } = parseImportSpecifier(hookImport.import);
  const candidates = buildImportCandidates(moduleSpecifier);
  if (candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    try {
      const loaded = (await import(candidate)) as Record<string, unknown>;
      const exported = exportName
        ? loaded[exportName]
        : loaded.default !== undefined
          ? loaded.default
          : loaded;
      const middleware = materializeMiddleware(exported, hookImport.params ?? {});
      if (middleware) {
        return middleware;
      }
    } catch {
      // Continue to next candidate.
    }
  }

  return null;
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

export async function resolveExecutionMiddlewares(
  definitions: HookDefinition[] | undefined,
): Promise<ExecutionMiddleware[]> {
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

    const external = await loadExternalMiddleware(hookImport);
    if (external) {
      middlewares.push(external);
      continue;
    }

    // Unknown middleware is treated as pass-through so existing YAML configs remain runnable.
    middlewares.push(PASSTHROUGH_MIDDLEWARE);
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
