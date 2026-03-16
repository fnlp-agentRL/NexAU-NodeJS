import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentConfig } from "../agent-config.js";
import { LLMConfig, type LLMConfigInput } from "../llm-config.js";
import type {
  ChatMessage,
  ExecuteOptions,
  ExecutionEvent,
  ExecutionResult,
  ExecutorDeps,
  LLMClient,
  LLMResponse,
  ToolCall,
} from "./types.js";
import {
  resolveExecutionMiddlewares,
  runExecutionMiddlewarePipeline,
  type ExecutionMiddlewareContext,
} from "./middleware.js";
import { resolveToolSelector } from "./tool-selector/resolve.js";
import type { TraceRunStart } from "../../tracer/base.js";
import { resolveTracer } from "../../tracer/resolve.js";

const MAX_SUBAGENT_DEPTH = 6;
const EXECUTION_INTERRUPTED_MESSAGE = "Execution interrupted";
const COMPACTED_TOOL_RESULT_PLACEHOLDER = "Tool call result has been compacted";

interface ContextCompactionOptions {
  strategy: "tool_result_compaction";
  threshold: number;
  keepIterations: number;
}

interface LongToolOutputOptions {
  maxOutputChars: number;
  headLines: number;
  tailLines: number;
  headChars: number;
  tailChars: number;
  tempDir: string | null;
  bypassToolNames: Set<string>;
}

interface LLMFailoverProvider {
  name: string;
  llmConfig: LLMConfigInput;
}

interface LLMFailoverOptions {
  statusCodes: Set<number>;
  exceptionTypes: Set<string>;
  providers: LLMFailoverProvider[];
}

class AbortExecutionError extends Error {
  public constructor(message = EXECUTION_INTERRUPTED_MESSAGE) {
    super(message);
    this.name = "AbortExecutionError";
  }
}

function estimateMessageTokens(message: ChatMessage): number {
  // Lightweight approximation for context control in phase-3.
  return Math.max(1, Math.ceil(message.content.length / 2.5));
}

function estimateContextTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function estimateSerializedTokens(value: unknown): {
  chars: number;
  tokens: number;
} {
  const serialized = (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();

  const chars = serialized.length;
  // Lightweight approximation: around 2.5 chars per token for mixed payload.
  const tokens = Math.max(1, Math.ceil(chars / 2.5));
  return { chars, tokens };
}

function estimatePromptTokenUsage(
  messages: ChatMessage[],
  tools: Array<Record<string, unknown>>,
): {
  promptTokens: number;
  messageTokens: number;
  toolTokens: number;
  promptChars: number;
  messageChars: number;
  toolChars: number;
} {
  const messageUsage = estimateSerializedTokens(messages);
  const toolUsage =
    tools.length === 0
      ? {
          chars: 0,
          tokens: 0,
        }
      : estimateSerializedTokens(tools);

  return {
    promptTokens: messageUsage.tokens + toolUsage.tokens,
    messageTokens: messageUsage.tokens,
    toolTokens: toolUsage.tokens,
    promptChars: messageUsage.chars + toolUsage.chars,
    messageChars: messageUsage.chars,
    toolChars: toolUsage.chars,
  };
}

function compactMessages(
  messages: ChatMessage[],
  maxTokens: number,
): {
  messages: ChatMessage[];
  dropped: number;
} {
  if (maxTokens <= 0) {
    return {
      messages,
      dropped: 0,
    };
  }

  const kept = [...messages];
  let dropped = 0;

  while (kept.length > 1 && estimateContextTokens(kept) > maxTokens) {
    // Keep earliest system message and the most recent context.
    const firstSystemIndex = kept.findIndex((message) => message.role === "system");
    const dropIndex = firstSystemIndex === 0 ? 1 : 0;
    kept.splice(dropIndex, 1);
    dropped += 1;
  }

  return {
    messages: kept,
    dropped,
  };
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutSeconds: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new AbortExecutionError();
  }

  const timeoutMs = Math.max(1, timeoutSeconds * 1000);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutSeconds}s`));
    }, timeoutMs);
    id.unref?.();
  });

  let onAbort: (() => void) | null = null;
  const interruptPromise =
    signal === undefined
      ? null
      : new Promise<never>((_resolve, reject) => {
          onAbort = (): void => {
            reject(new AbortExecutionError());
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });

  try {
    const raced = interruptPromise
      ? Promise.race([operation(), timeoutPromise, interruptPromise])
      : Promise.race([operation(), timeoutPromise]);
    return await raced;
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function withRetryAndTimeout<T>(
  operation: () => Promise<T>,
  retryAttempts: number,
  timeoutSeconds: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  const maxAttempts = Math.max(1, retryAttempts + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTimeout(operation, timeoutSeconds, label, signal);
    } catch (error) {
      lastError = error;
      if (error instanceof AbortExecutionError) {
        break;
      }
      if (attempt >= maxAttempts) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function normalizeOptionalPrompt(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function renderSystemPrompt(agent: AgentConfig, systemPromptAddition?: string): string | null {
  const base = (() => {
    if (!agent.system_prompt) {
      return null;
    }

    if (typeof agent.system_prompt === "string") {
      return agent.system_prompt.trimEnd();
    }

    return agent.system_prompt
      .map((item) => (typeof item === "string" ? item : item.content))
      .join("\n\n")
      .trimEnd();
  })();

  const addition = normalizeOptionalPrompt(systemPromptAddition);
  if (!base && !addition) {
    return null;
  }
  if (!base) {
    return addition;
  }
  if (!addition) {
    return base;
  }
  return `${base}\n\n${addition}`;
}

function normalizeToolCalls(response: LLMResponse): ToolCall[] {
  return (response.tool_calls ?? []).map((call) => ({
    id: call.id || randomUUID(),
    name: call.name,
    arguments: call.arguments ?? {},
  }));
}

function serializeUnknownPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function serializeToolPayload(payload: Record<string, unknown>): string {
  return serializeUnknownPayload(payload);
}

function stripReturnDisplayField(payload: Record<string, unknown>): {
  sanitized: Record<string, unknown>;
  changed: boolean;
} {
  if (!("returnDisplay" in payload)) {
    return {
      sanitized: payload,
      changed: false,
    };
  }
  const { returnDisplay: _ignored, ...rest } = payload;
  return {
    sanitized: rest,
    changed: true,
  };
}

function formatThousands(value: number): string {
  return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function extractToolContentText(payload: Record<string, unknown>): {
  contentKey: "content" | "result" | null;
  contentText: string | null;
} {
  for (const key of ["content", "result"] as const) {
    const value = payload[key];
    if (typeof value === "string") {
      return {
        contentKey: key,
        contentText: value,
      };
    }
  }
  return {
    contentKey: null,
    contentText: null,
  };
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...<truncated>`;
}

function summarizeToolResultForEvent(toolResult: Record<string, unknown>): {
  hasError: boolean;
  error?: string;
  errorType?: string;
  traceback?: string;
  toolResultPreview: string;
} {
  const hasError = "error" in toolResult;
  const errorRaw = toolResult.error;
  const errorTypeRaw = toolResult.error_type;
  const tracebackRaw = toolResult.traceback;

  const error =
    typeof errorRaw === "string"
      ? errorRaw
      : errorRaw !== undefined
        ? truncateString(String(errorRaw), 2000)
        : undefined;
  const errorType =
    typeof errorTypeRaw === "string"
      ? errorTypeRaw
      : errorTypeRaw !== undefined
        ? truncateString(String(errorTypeRaw), 500)
        : undefined;
  const traceback =
    typeof tracebackRaw === "string"
      ? truncateString(tracebackRaw, 6000)
      : tracebackRaw !== undefined
        ? truncateString(String(tracebackRaw), 6000)
        : undefined;

  let toolResultPreview = "";
  try {
    toolResultPreview = truncateString(JSON.stringify(toolResult), 6000);
  } catch {
    toolResultPreview = truncateString(String(toolResult), 6000);
  }

  return {
    hasError,
    ...(error !== undefined ? { error } : {}),
    ...(errorType !== undefined ? { errorType } : {}),
    ...(traceback !== undefined ? { traceback } : {}),
    toolResultPreview,
  };
}

function resolveStructuredToolDescription(tool: AgentConfig["tools"][number]): string {
  if (tool.asSkill) {
    if (!tool.skillDescription) {
      throw new Error(`Tool ${tool.name} is marked as a skill but has no skill_description`);
    }
    return tool.skillDescription;
  }
  return tool.description;
}

function buildStructuredToolPayload(
  agent: AgentConfig,
  selectedToolNames?: Set<string>,
): Array<Record<string, unknown>> {
  return agent.tools.flatMap((tool) => {
    if (selectedToolNames && !selectedToolNames.has(tool.name)) {
      return [];
    }
    const payload = tool.toOpenAI();
    const fn = payload.function;
    if (fn && typeof fn === "object") {
      return [
        {
          ...payload,
          function: {
            ...fn,
            description: resolveStructuredToolDescription(tool),
          },
        },
      ];
    }
    return [payload];
  });
}

function normalizeThreshold(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(1, Math.max(0, value));
  }
  return defaultValue;
}

function normalizeKeepIterations(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return defaultValue;
}

function resolveContextCompactionOptions(
  middlewares: AgentConfig["middlewares"],
): ContextCompactionOptions | null {
  if (!middlewares || middlewares.length === 0) {
    return null;
  }

  for (const middleware of middlewares) {
    if (typeof middleware !== "object" || middleware === null) {
      continue;
    }
    if (!("import" in middleware) || typeof middleware.import !== "string") {
      continue;
    }
    const importPath = middleware.import.toLowerCase();
    if (!importPath.includes("context_compaction")) {
      continue;
    }

    const params = middleware.params;
    const strategyRaw =
      params && typeof params === "object" && "compaction_strategy" in params
        ? params.compaction_strategy
        : undefined;
    const strategy = strategyRaw === "tool_result_compaction" ? "tool_result_compaction" : null;
    if (!strategy) {
      continue;
    }

    const thresholdRaw =
      params && typeof params === "object" && "threshold" in params ? params.threshold : undefined;
    const keepIterationsRaw =
      params && typeof params === "object" && "keep_iterations" in params
        ? params.keep_iterations
        : undefined;

    return {
      strategy,
      threshold: normalizeThreshold(thresholdRaw, 0.75),
      keepIterations: normalizeKeepIterations(keepIterationsRaw, 3),
    };
  }

  return null;
}

function parseLongOutputPositiveInteger(
  value: unknown,
  fieldName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`[LongToolOutputMiddleware] ${fieldName} must be a finite number`);
  }
  const parsed = Math.floor(value);
  if (parsed < 1) {
    throw new Error(`[LongToolOutputMiddleware] ${fieldName} must be >= 1`);
  }
  return parsed;
}

function parseLongOutputNonNegativeInteger(
  value: unknown,
  fieldName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`[LongToolOutputMiddleware] ${fieldName} must be a finite number`);
  }
  const parsed = Math.floor(value);
  if (parsed < 0) {
    throw new Error(`[LongToolOutputMiddleware] ${fieldName} must be >= 0`);
  }
  return parsed;
}

function resolveLongToolOutputOptions(
  middlewares: AgentConfig["middlewares"],
): LongToolOutputOptions | null {
  if (!middlewares || middlewares.length === 0) {
    return null;
  }

  for (const middleware of middlewares) {
    if (typeof middleware !== "object" || middleware === null) {
      continue;
    }
    if (!("import" in middleware) || typeof middleware.import !== "string") {
      continue;
    }
    const importPath = middleware.import.toLowerCase();
    if (!importPath.includes("long_tool_output")) {
      continue;
    }

    const params = middleware.params;
    const enabledRaw =
      params && typeof params === "object" && "enabled" in params ? params.enabled : true;
    if (enabledRaw === false) {
      return null;
    }

    const maxOutputCharsRaw =
      params && typeof params === "object" && "max_output_chars" in params
        ? params.max_output_chars
        : undefined;
    const headLinesRaw =
      params && typeof params === "object" && "head_lines" in params
        ? params.head_lines
        : undefined;
    const tailLinesRaw =
      params && typeof params === "object" && "tail_lines" in params
        ? params.tail_lines
        : undefined;
    const headCharsRaw =
      params && typeof params === "object" && "head_chars" in params
        ? params.head_chars
        : undefined;
    const tailCharsRaw =
      params && typeof params === "object" && "tail_chars" in params
        ? params.tail_chars
        : undefined;
    const bypassRaw =
      params && typeof params === "object" && "bypass_tool_names" in params
        ? params.bypass_tool_names
        : undefined;
    const tempDirRaw =
      params && typeof params === "object" && "temp_dir" in params ? params.temp_dir : undefined;

    const bypassToolNames = new Set<string>();
    if (bypassRaw !== undefined) {
      if (!Array.isArray(bypassRaw)) {
        throw new Error("[LongToolOutputMiddleware] bypass_tool_names must be an array of strings");
      }
      for (const item of bypassRaw) {
        if (typeof item !== "string" || item.length === 0) {
          throw new Error(
            "[LongToolOutputMiddleware] bypass_tool_names must contain non-empty strings",
          );
        }
        bypassToolNames.add(item);
      }
    }

    const maxOutputChars = parseLongOutputPositiveInteger(
      maxOutputCharsRaw,
      "max_output_chars",
      10_000,
    );
    const headLines = parseLongOutputNonNegativeInteger(headLinesRaw, "head_lines", 50);
    const tailLines = parseLongOutputNonNegativeInteger(tailLinesRaw, "tail_lines", 30);
    const headChars = parseLongOutputNonNegativeInteger(headCharsRaw, "head_chars", 5_000);
    const tailChars = parseLongOutputNonNegativeInteger(tailCharsRaw, "tail_chars", 5_000);
    if (headChars + tailChars > maxOutputChars) {
      throw new Error(
        "[LongToolOutputMiddleware] head_chars + tail_chars must be <= max_output_chars",
      );
    }
    const tempDir =
      tempDirRaw === null
        ? null
        : typeof tempDirRaw === "string" && tempDirRaw.trim().length > 0
          ? tempDirRaw
          : tempDirRaw === undefined || tempDirRaw === ""
            ? "/tmp/nexau_tool_outputs"
            : (() => {
                throw new Error("[LongToolOutputMiddleware] temp_dir must be a string or null");
              })();

    return {
      maxOutputChars,
      headLines,
      tailLines,
      headChars,
      tailChars,
      tempDir,
      bypassToolNames,
    };
  }

  return null;
}

function truncateByLines(text: string, headLines: number, tailLines: number): string | null {
  if (headLines <= 0 && tailLines <= 0) {
    return null;
  }

  const lines = text.match(/.*?(?:\n|$)/g) ?? [];
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;
  if (totalLines <= headLines + tailLines) {
    return text;
  }

  const head = headLines > 0 ? lines.slice(0, headLines).join("") : "";
  const tail = tailLines > 0 ? lines.slice(-tailLines).join("") : "";
  const omitted = Math.max(0, totalLines - headLines - tailLines);
  const separator = `\n... [${omitted} lines omitted] ...\n`;
  return `${head}${separator}${tail}`;
}

function truncateByChars(text: string, headChars: number, tailChars: number): string | null {
  if (headChars <= 0 && tailChars <= 0) {
    return null;
  }
  if (text.length <= headChars + tailChars) {
    return text;
  }

  const head = headChars > 0 ? text.slice(0, headChars) : "";
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const omitted = Math.max(0, text.length - headChars - tailChars);
  const separator = `\n... [${omitted} chars omitted] ...\n`;
  return `${head}${separator}${tail}`;
}

function selectTruncatedText(
  sourceText: string,
  lineCandidate: string | null,
  charCandidate: string | null,
  maxOutputChars: number,
): string {
  const candidates: string[] = [];
  if (lineCandidate !== null) {
    candidates.push(lineCandidate);
  }
  if (charCandidate !== null) {
    candidates.push(charCandidate);
  }
  if (candidates.length === 0) {
    return sourceText;
  }

  const shortenedCandidates = candidates.filter(
    (candidate) => candidate.length < sourceText.length,
  );
  const effectiveCandidates = shortenedCandidates.length > 0 ? shortenedCandidates : candidates;
  const validCandidates = effectiveCandidates.filter(
    (candidate) => candidate.length < maxOutputChars,
  );
  if (validCandidates.length > 0) {
    return validCandidates.reduce((best, candidate) =>
      candidate.length > best.length ? candidate : best,
    );
  }

  if (effectiveCandidates.length === 1) {
    return effectiveCandidates[0]!;
  }

  return effectiveCandidates.reduce((best, candidate) =>
    candidate.length < best.length ? candidate : best,
  );
}

function buildTruncatedToolPayload(
  originalPayload: Record<string, unknown>,
  truncatedText: string,
  hint: string,
  contentKey: "content" | "result" | null,
): Record<string, unknown> {
  const combined = `${truncatedText}${hint}`;
  if (contentKey) {
    return {
      ...originalPayload,
      [contentKey]: combined,
    };
  }
  if ("content" in originalPayload) {
    return {
      ...originalPayload,
      content: combined,
    };
  }
  if ("result" in originalPayload) {
    return {
      ...originalPayload,
      result: combined,
    };
  }
  return {
    content: combined,
  };
}

function applyLongToolOutputGuard(
  toolResult: Record<string, unknown>,
  toolName: string,
  toolCallId: string,
  options: LongToolOutputOptions | null,
): {
  content: string;
  truncated: boolean;
  originalChars?: number;
  savedPath?: string;
} {
  const serializedToolResult = serializeToolPayload(toolResult);
  if (!options) {
    return {
      content: serializedToolResult,
      truncated: false,
    };
  }

  if (options.bypassToolNames.has(toolName)) {
    return {
      content: serializedToolResult,
      truncated: false,
    };
  }

  const outputForMeasurement = stripReturnDisplayField(toolResult).sanitized;
  const outputText = serializeUnknownPayload(outputForMeasurement);
  if (outputText.length <= options.maxOutputChars) {
    return {
      content: serializedToolResult,
      truncated: false,
    };
  }

  const extracted = extractToolContentText(outputForMeasurement);
  const textToTruncate = extracted.contentText ?? outputText;
  const textForStats = extracted.contentText ?? outputText;
  const lineCandidate = truncateByLines(textToTruncate, options.headLines, options.tailLines);
  const charCandidate = truncateByChars(textToTruncate, options.headChars, options.tailChars);
  const truncatedBody = selectTruncatedText(
    textToTruncate,
    lineCandidate,
    charCandidate,
    options.maxOutputChars,
  );

  let savedPath: string | undefined;
  if (options.tempDir) {
    const safeToolName = toolName.replaceAll("/", "_").replaceAll("\\", "_").replaceAll(" ", "_");
    const shortId = toolCallId.length > 8 ? toolCallId.slice(-8) : toolCallId;
    const fileName = `${safeToolName}_${shortId}_${Date.now()}.txt`;
    const filePath = join(options.tempDir, fileName);
    try {
      mkdirSync(options.tempDir, { recursive: true });
      writeFileSync(filePath, outputText, "utf-8");
      savedPath = filePath;
    } catch {
      savedPath = undefined;
    }
  }

  const totalChars = textForStats.length;
  const totalLines = textForStats.split("\n").length;
  const hint = savedPath
    ? `\n\n⚠️ [LongToolOutputMiddleware] The full output (${formatThousands(totalChars)} chars, ~${totalLines} lines) has been truncated. The complete output has been saved to:\n  ${savedPath}\nUse the read file tool to view the full content if needed.`
    : `\n\n⚠️ [LongToolOutputMiddleware] The full output (${formatThousands(totalChars)} chars, ~${totalLines} lines) has been truncated.`;
  const truncatedPayload = buildTruncatedToolPayload(
    outputForMeasurement,
    truncatedBody,
    hint,
    extracted.contentKey,
  );
  return {
    content: serializeToolPayload(truncatedPayload),
    truncated: true,
    originalChars: totalChars,
    ...(savedPath ? { savedPath } : {}),
  };
}

function readObjectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (!(key in value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function normalizeFailoverStatusCodes(value: unknown): Set<number> {
  const defaults = new Set([500, 502, 503, 504, 529]);
  if (!Array.isArray(value)) {
    return defaults;
  }

  const parsed = new Set<number>();
  for (const item of value) {
    if (typeof item === "number" && Number.isInteger(item)) {
      parsed.add(item);
    }
  }
  return parsed.size > 0 ? parsed : defaults;
}

function normalizeFailoverExceptionTypes(value: unknown): Set<string> {
  const defaults = new Set(["RateLimitError", "InternalServerError", "APIConnectionError"]);
  if (!Array.isArray(value)) {
    return defaults;
  }

  const parsed = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      parsed.add(item);
    }
  }
  return parsed.size > 0 ? parsed : defaults;
}

function resolveLLMFailoverOptions(
  middlewares: AgentConfig["middlewares"],
): LLMFailoverOptions | null {
  if (!middlewares || middlewares.length === 0) {
    return null;
  }

  for (const middleware of middlewares) {
    if (typeof middleware !== "object" || middleware === null) {
      continue;
    }
    if (!("import" in middleware) || typeof middleware.import !== "string") {
      continue;
    }
    const importPath = middleware.import.toLowerCase();
    if (!importPath.includes("llm_failover")) {
      continue;
    }

    const params = middleware.params;
    const enabledRaw =
      params && typeof params === "object" && "enabled" in params ? params.enabled : true;
    if (enabledRaw === false) {
      return null;
    }

    const fallbackProvidersRaw =
      params && typeof params === "object" && "fallback_providers" in params
        ? params.fallback_providers
        : undefined;
    if (!Array.isArray(fallbackProvidersRaw)) {
      return null;
    }

    const providers: LLMFailoverProvider[] = [];
    for (let index = 0; index < fallbackProvidersRaw.length; index += 1) {
      const item = fallbackProvidersRaw[index];
      if (!item || typeof item !== "object") {
        continue;
      }
      const llmConfigRaw = readObjectValue(item, "llm_config");
      if (!llmConfigRaw || typeof llmConfigRaw !== "object") {
        continue;
      }
      const nameRaw = readObjectValue(item, "name");
      providers.push({
        name: typeof nameRaw === "string" && nameRaw.length > 0 ? nameRaw : `fallback-${index + 1}`,
        llmConfig: llmConfigRaw as LLMConfigInput,
      });
    }
    if (providers.length === 0) {
      return null;
    }

    const trigger = readObjectValue(params, "trigger");
    const statusCodes = normalizeFailoverStatusCodes(readObjectValue(trigger, "status_codes"));
    const exceptionTypes = normalizeFailoverExceptionTypes(
      readObjectValue(trigger, "exception_types"),
    );

    return {
      statusCodes,
      exceptionTypes,
      providers,
    };
  }

  return null;
}

function extractStatusCodeFromError(error: Error): number | null {
  const match = error.message.match(/\((\d{3})\)/);
  if (!match || !match[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function shouldTriggerLLMFailover(error: Error, options: LLMFailoverOptions): boolean {
  const statusCode = extractStatusCodeFromError(error);
  if (statusCode !== null && options.statusCodes.has(statusCode)) {
    return true;
  }

  if (options.exceptionTypes.has(error.name)) {
    return true;
  }

  for (const typeName of options.exceptionTypes) {
    if (error.message.includes(typeName)) {
      return true;
    }
  }

  return false;
}

function toLLMConfigInput(config: LLMConfig): LLMConfigInput {
  return {
    model: config.model,
    base_url: config.base_url,
    api_key: config.api_key,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    top_p: config.top_p,
    frequency_penalty: config.frequency_penalty,
    presence_penalty: config.presence_penalty,
    timeout: config.timeout,
    max_retries: config.max_retries,
    debug: config.debug,
    stream: config.stream,
    additional_drop_params: [...config.additional_drop_params],
    api_type: config.api_type,
    cache_control_ttl: config.cache_control_ttl,
    ...config.extra_params,
  };
}

function buildAgentWithFallbackConfig(
  agent: AgentConfig,
  llmConfigPatch: LLMConfigInput,
): AgentConfig {
  const mergedConfig: LLMConfigInput = {
    ...toLLMConfigInput(agent.llm_config),
    ...llmConfigPatch,
  };
  return {
    ...agent,
    llm_config: new LLMConfig(mergedConfig),
  } as AgentConfig;
}

function compactToolResults(
  messages: ChatMessage[],
  keepIterations: number,
): {
  messages: ChatMessage[];
  compacted: number;
} {
  let assistantSeen = 0;
  let protectFrom = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "assistant") {
      continue;
    }
    assistantSeen += 1;
    if (assistantSeen >= keepIterations) {
      protectFrom = index;
      break;
    }
  }

  if (assistantSeen < keepIterations) {
    protectFrom = 0;
  }

  let compacted = 0;
  const next = messages.map((message, index) => {
    if (index >= protectFrom || message.role !== "tool") {
      return message;
    }
    if (message.content === COMPACTED_TOOL_RESULT_PLACEHOLDER) {
      return message;
    }
    compacted += 1;
    return {
      ...message,
      content: COMPACTED_TOOL_RESULT_PLACEHOLDER,
    };
  });

  return {
    messages: next,
    compacted,
  };
}

function toolMap(agent: AgentConfig): Map<string, AgentConfig["tools"][number]> {
  const map = new Map<string, AgentConfig["tools"][number]>();
  for (const tool of agent.tools) {
    map.set(tool.name, tool);
  }
  return map;
}

function resolveSubAgentName(
  toolCall: ToolCall,
  subAgents: Record<string, AgentConfig>,
): string | null {
  if (toolCall.name in subAgents) {
    return toolCall.name;
  }

  if (!["RecallSubAgent", "recall_sub_agent", "recall_subagent"].includes(toolCall.name)) {
    return null;
  }

  const candidateKeys = ["sub_agent_name", "subAgentName", "agent_name", "agentName", "name"];

  for (const key of candidateKeys) {
    const value = toolCall.arguments[key];
    if (typeof value === "string" && value in subAgents) {
      return value;
    }
  }

  return null;
}

function resolveSubAgentInput(toolCall: ToolCall): string {
  const candidateKeys = ["message", "query", "task", "input", "prompt"];
  for (const key of candidateKeys) {
    const value = toolCall.arguments[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function buildInterruptedResult(
  iteration: number,
  output: string,
  messages: ChatMessage[],
  events: ExecutionEvent[],
): ExecutionResult {
  return {
    status: "failed",
    output,
    iterations: iteration,
    messages,
    events,
    error: EXECUTION_INTERRUPTED_MESSAGE,
  };
}

function ensureNotInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AbortExecutionError();
  }
}

export class AgentExecutor {
  private readonly deps: ExecutorDeps;

  public constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  public async execute(options: ExecuteOptions): Promise<ExecutionResult> {
    const middlewares = await resolveExecutionMiddlewares(options.agent.middlewares);
    const context: ExecutionMiddlewareContext = {
      agent: options.agent,
      input: options.input,
      history: options.history ? [...options.history] : [],
      systemPromptAddition: options.systemPromptAddition,
      agentState: options.agentState ?? {},
      recursionDepth: options.recursionDepth ?? 0,
      signal: options.signal,
      traceContext: options.traceContext,
      onEvent: options.onEvent,
    };

    return runExecutionMiddlewarePipeline(middlewares, context, (nextContext) =>
      this.executeWithTracing(nextContext),
    );
  }

  private async executeWithTracing(context: ExecutionMiddlewareContext): Promise<ExecutionResult> {
    const tracer = resolveTracer(context.agent.tracers);
    const traceRun: TraceRunStart = {
      runId: randomUUID(),
      agentName: context.agent.name,
      input: context.input,
      recursionDepth: context.recursionDepth,
      userId: context.traceContext?.userId,
      sessionId: context.traceContext?.sessionId,
      tags: context.traceContext?.tags,
      metadata: context.traceContext?.metadata,
    };
    const events: ExecutionEvent[] = [];
    const traceTasks: Promise<void>[] = [];

    const recordTrace = (operation: (() => void | Promise<void>) | undefined): void => {
      if (!operation) {
        return;
      }
      traceTasks.push(
        Promise.resolve()
          .then(() => operation())
          .catch(() => undefined),
      );
    };

    if (tracer) {
      recordTrace(() => tracer.startRun(traceRun));
    }

    const emit = (event: ExecutionEvent): void => {
      events.push(event);
      context.onEvent?.(event);
      if (tracer) {
        recordTrace(() => tracer.onEvent(traceRun, event));
      }
    };

    const result = await this.executeCore(context, events, emit);

    if (tracer) {
      recordTrace(() =>
        tracer.endRun({
          ...traceRun,
          result,
        }),
      );
      if (tracer.flush) {
        recordTrace(() => tracer.flush?.());
      }
    }

    await Promise.allSettled(traceTasks);
    return result;
  }

  private async executeCore(
    context: ExecutionMiddlewareContext,
    events: ExecutionEvent[],
    emit: (event: ExecutionEvent) => void,
  ): Promise<ExecutionResult> {
    const recursionDepth = context.recursionDepth;
    const signal = context.signal;
    if (recursionDepth > MAX_SUBAGENT_DEPTH) {
      return {
        status: "failed",
        output: "",
        iterations: 0,
        messages: [],
        events,
        error: `Exceeded max sub-agent recursion depth (${MAX_SUBAGENT_DEPTH})`,
      };
    }

    const agent = context.agent;
    const primaryLLMClient: LLMClient = this.deps.createLLMClient(agent);

    const messages: ChatMessage[] = [];
    const systemPrompt = renderSystemPrompt(agent, context.systemPromptAddition);
    if (systemPrompt) {
      messages.push({
        role: "system",
        content: systemPrompt,
      });
    }

    messages.push(...context.history);
    messages.push({
      role: "user",
      content: context.input,
    });

    emit({
      type: "run.started",
      payload: {
        agent_name: agent.name,
        max_iterations: agent.max_iterations,
      },
    });

    const toolByName = toolMap(agent);
    const allToolNames = agent.tools.map((tool) => tool.name);
    const agentState = context.agentState;
    const contextCompaction = resolveContextCompactionOptions(agent.middlewares);
    const longToolOutput = resolveLongToolOutputOptions(agent.middlewares);
    const llmFailover = resolveLLMFailoverOptions(agent.middlewares);
    const toolSelectorResolution = resolveToolSelector(agent.middlewares);
    const toolSelector = toolSelectorResolution?.selector ?? null;

    if (toolSelectorResolution?.error) {
      emit({
        type: "tool.selection",
        payload: {
          iteration: 0,
          mode: toolSelectorResolution.mode,
          source_import: toolSelectorResolution.sourceImport,
          selector_error: toolSelectorResolution.error,
          selected_tool_count: allToolNames.length,
          total_tool_count: allToolNames.length,
          fallback_to_all: true,
        },
      });
    }

    let output = "";
    let stopToolName: string | undefined;
    let lastToolResult: Record<string, unknown> | undefined;

    const executeDirectToolCall = async (toolCall: ToolCall): Promise<Record<string, unknown>> => {
      const tool = toolByName.get(toolCall.name);
      if (!tool) {
        return {
          error: `Tool '${toolCall.name}' not found`,
          error_type: "ToolNotFound",
          traceback: "",
          tool_name: toolCall.name,
        };
      }

      return withRetryAndTimeout(
        () => tool.execute({ ...toolCall.arguments, agent_state: agentState }),
        agent.retry_attempts,
        agent.timeout,
        `Tool '${tool.name}'`,
        signal,
      );
    };

    const executeSingleToolCall = async (
      toolCall: ToolCall,
      iteration: number,
    ): Promise<Record<string, unknown>> => {
      const subAgentName = resolveSubAgentName(toolCall, agent.sub_agents);
      if (!subAgentName) {
        return executeDirectToolCall(toolCall);
      }

      const subAgent = agent.sub_agents[subAgentName];
      if (!subAgent) {
        return {
          error: `Sub-agent '${subAgentName}' not found`,
          error_type: "SubAgentNotFound",
          traceback: "",
          tool_name: toolCall.name,
        };
      }
      const subInput = resolveSubAgentInput(toolCall);

      emit({
        type: "subagent.called",
        payload: {
          iteration,
          sub_agent_name: subAgentName,
        },
      });

      const subResult = await this.execute({
        agent: subAgent,
        input: subInput,
        systemPromptAddition: context.systemPromptAddition,
        agentState,
        recursionDepth: recursionDepth + 1,
        signal,
        traceContext: context.traceContext,
        onEvent: context.onEvent,
      });

      emit({
        type: "subagent.completed",
        payload: {
          iteration,
          sub_agent_name: subAgentName,
          status: subResult.status,
        },
      });

      return {
        sub_agent: subAgentName,
        status: subResult.status,
        output: subResult.output,
      };
    };

    for (let iteration = 1; iteration <= agent.max_iterations; iteration += 1) {
      let preCallCompactionTriggered = false;
      if (signal?.aborted) {
        emit({
          type: "run.failed",
          payload: {
            iteration,
            error: EXECUTION_INTERRUPTED_MESSAGE,
          },
        });
        return buildInterruptedResult(iteration, output, messages, events);
      }

      if (contextCompaction) {
        const estimatedTokens = estimateContextTokens(messages);
        const usageRatio =
          agent.max_context_tokens <= 0 ? 1 : estimatedTokens / agent.max_context_tokens;
        if (usageRatio >= contextCompaction.threshold) {
          preCallCompactionTriggered = true;
          const compacted = compactToolResults(messages, contextCompaction.keepIterations);
          messages.length = 0;
          messages.push(...compacted.messages);
          emit({
            type: "context.compacted",
            payload: {
              dropped_messages: 0,
              current_messages: messages.length,
              compacted_tool_results: compacted.compacted,
            },
          });
        }
      } else {
        const compacted = compactMessages(messages, agent.max_context_tokens);
        if (compacted.dropped > 0) {
          messages.length = 0;
          messages.push(...compacted.messages);
          emit({
            type: "context.compacted",
            payload: {
              dropped_messages: compacted.dropped,
              current_messages: messages.length,
            },
          });
        }
      }

      let selectedToolNames = allToolNames;
      let selectorTrace: Record<string, unknown> | undefined;
      let selectorFallbackToAll = false;
      let selectorError: string | undefined;

      if (toolSelector) {
        try {
          const selection = await toolSelector.select({
            query: context.input,
            messages,
            tools: agent.tools,
            agentState,
            iteration,
          });
          selectorTrace = selection.trace;

          const candidate = selection.selectedToolNames.filter((name) => toolByName.has(name));
          if (candidate.length > 0) {
            selectedToolNames = [...new Set(candidate)];
          } else {
            selectorFallbackToAll = true;
            selectedToolNames = allToolNames;
          }
        } catch (error) {
          selectorFallbackToAll = true;
          selectedToolNames = allToolNames;
          selectorError = error instanceof Error ? error.message : String(error);
        }

        emit({
          type: "tool.selection",
          payload: {
            iteration,
            mode: toolSelectorResolution?.mode ?? "passthrough",
            source_import: toolSelectorResolution?.sourceImport ?? "runtime-default",
            total_tool_count: allToolNames.length,
            selected_tool_count: selectedToolNames.length,
            selected_tool_names_preview: selectedToolNames.slice(0, 20),
            fallback_to_all: selectorFallbackToAll,
            ...(selectorError ? { selector_error: selectorError } : {}),
            ...(selectorTrace ? { selector_trace: selectorTrace } : {}),
          },
        });
      }

      const tools = buildStructuredToolPayload(agent, new Set(selectedToolNames));
      const tokenUsage = estimatePromptTokenUsage(messages, tools);

      emit({
        type: "llm.requested",
        payload: {
          iteration,
          message_count: messages.length,
          tool_count: tools.length,
          total_tool_count: allToolNames.length,
          prompt_tokens_estimated: tokenUsage.promptTokens,
          prompt_message_tokens_estimated: tokenUsage.messageTokens,
          prompt_tool_tokens_estimated: tokenUsage.toolTokens,
          prompt_chars_estimated: tokenUsage.promptChars,
          prompt_message_chars_estimated: tokenUsage.messageChars,
          prompt_tool_chars_estimated: tokenUsage.toolChars,
        },
      });

      let response: LLMResponse;
      try {
        ensureNotInterrupted(signal);
        response = await withRetryAndTimeout(
          () => primaryLLMClient.complete({ agent, messages, tools }),
          agent.retry_attempts,
          agent.timeout,
          `LLM call for agent '${agent.name}'`,
          signal,
        );
      } catch (error) {
        if (error instanceof AbortExecutionError) {
          emit({
            type: "run.failed",
            payload: {
              iteration,
              error: EXECUTION_INTERRUPTED_MESSAGE,
            },
          });
          return buildInterruptedResult(iteration, output, messages, events);
        }

        const llmError = error instanceof Error ? error : new Error(String(error));
        let failoverResponse: LLMResponse | null = null;

        if (llmFailover && shouldTriggerLLMFailover(llmError, llmFailover)) {
          emit({
            type: "llm.failover.triggered",
            payload: {
              iteration,
              error: llmError.message,
              provider_count: llmFailover.providers.length,
              status_code: extractStatusCodeFromError(llmError),
            },
          });

          for (const provider of llmFailover.providers) {
            emit({
              type: "llm.failover.attempted",
              payload: {
                iteration,
                provider_name: provider.name,
              },
            });

            const fallbackAgent = buildAgentWithFallbackConfig(agent, provider.llmConfig);
            const fallbackClient = this.deps.createLLMClient(fallbackAgent);
            try {
              ensureNotInterrupted(signal);
              failoverResponse = await withRetryAndTimeout(
                () => fallbackClient.complete({ agent: fallbackAgent, messages, tools }),
                agent.retry_attempts,
                agent.timeout,
                `LLM failover call for provider '${provider.name}'`,
                signal,
              );
              emit({
                type: "llm.failover.succeeded",
                payload: {
                  iteration,
                  provider_name: provider.name,
                  model: fallbackAgent.llm_config.model,
                },
              });
              break;
            } catch (fallbackError) {
              if (fallbackError instanceof AbortExecutionError) {
                emit({
                  type: "run.failed",
                  payload: {
                    iteration,
                    error: EXECUTION_INTERRUPTED_MESSAGE,
                  },
                });
                return buildInterruptedResult(iteration, output, messages, events);
              }
              emit({
                type: "llm.failover.failed",
                payload: {
                  iteration,
                  provider_name: provider.name,
                  error:
                    fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
                },
              });
            }
          }
        }

        if (failoverResponse) {
          response = failoverResponse;
        } else {
          emit({
            type: "run.failed",
            payload: {
              iteration,
              error: llmError.message,
            },
          });
          return {
            status: "failed",
            output,
            iterations: iteration,
            messages,
            events,
            error: llmError.message,
          };
        }
      }

      const toolCalls = normalizeToolCalls(response);

      output = response.content;
      const assistantContent =
        toolCalls.length > 0 && response.content.length === 0 ? "null" : response.content;
      messages.push({
        role: "assistant",
        content: assistantContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });

      emit({
        type: "llm.responded",
        payload: {
          iteration,
          content_length: response.content.length,
          tool_call_count: toolCalls.length,
        },
      });

      if (contextCompaction && toolCalls.length > 0 && preCallCompactionTriggered) {
        const compacted = compactToolResults(messages, contextCompaction.keepIterations);
        messages.length = 0;
        messages.push(...compacted.messages);
        emit({
          type: "context.compacted",
          payload: {
            dropped_messages: 0,
            current_messages: messages.length,
            compacted_tool_results: compacted.compacted,
          },
        });
      }

      if (toolCalls.length === 0) {
        emit({
          type: "run.completed",
          payload: {
            iteration,
            status: "completed",
          },
        });
        return {
          status: "completed",
          output,
          iterations: iteration,
          messages,
          events,
        };
      }

      const canExecuteParallel =
        toolCalls.length > 1 &&
        toolCalls.every((toolCall) => {
          if (resolveSubAgentName(toolCall, agent.sub_agents)) {
            return false;
          }
          const tool = toolByName.get(toolCall.name);
          if (!tool) {
            return false;
          }
          if (tool.disableParallel) {
            return false;
          }
          return !agent.stop_tools.has(toolCall.name);
        });

      for (const toolCall of toolCalls) {
        emit({
          type: "tool.called",
          payload: {
            iteration,
            tool_name: toolCall.name,
            tool_call_id: toolCall.id,
            tool_arguments: toolCall.arguments,
          },
        });
      }

      let toolResults: Record<string, unknown>[];
      try {
        if (canExecuteParallel) {
          toolResults = await Promise.all(
            toolCalls.map((toolCall) => executeDirectToolCall(toolCall)),
          );
        } else {
          toolResults = [];
          for (const toolCall of toolCalls) {
            if (signal?.aborted) {
              throw new AbortExecutionError();
            }
            const result = await executeSingleToolCall(toolCall, iteration);
            toolResults.push(result);
          }
        }
      } catch (error) {
        if (error instanceof AbortExecutionError) {
          emit({
            type: "run.failed",
            payload: {
              iteration,
              error: EXECUTION_INTERRUPTED_MESSAGE,
            },
          });
          return buildInterruptedResult(iteration, output, messages, events);
        }
        emit({
          type: "run.failed",
          payload: {
            iteration,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return {
          status: "failed",
          output,
          iterations: iteration,
          messages,
          events,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      for (let index = 0; index < toolCalls.length; index += 1) {
        const toolCall = toolCalls[index]!;
        const toolResult = toolResults[index]!;
        const toolSummary = summarizeToolResultForEvent(toolResult);
        lastToolResult = toolResult;
        const sanitizedToolResult = stripReturnDisplayField(toolResult).sanitized;
        const guardedToolOutput = applyLongToolOutputGuard(
          sanitizedToolResult,
          toolCall.name,
          toolCall.id,
          longToolOutput,
        );

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: guardedToolOutput.content,
        });

        emit({
          type: "tool.completed",
          payload: {
            iteration,
            tool_name: toolCall.name,
            tool_call_id: toolCall.id,
            has_error: toolSummary.hasError,
            ...(toolSummary.error !== undefined ? { error: toolSummary.error } : {}),
            ...(toolSummary.errorType !== undefined ? { error_type: toolSummary.errorType } : {}),
            ...(toolSummary.traceback !== undefined ? { traceback: toolSummary.traceback } : {}),
            tool_result_preview: toolSummary.toolResultPreview,
            ...(guardedToolOutput.truncated
              ? {
                  tool_output_truncated: true,
                  tool_output_original_chars: guardedToolOutput.originalChars,
                  ...(guardedToolOutput.savedPath
                    ? { tool_output_saved_path: guardedToolOutput.savedPath }
                    : {}),
                }
              : {}),
          },
        });

        if (agent.stop_tools.has(toolCall.name)) {
          stopToolName = toolCall.name;
          emit({
            type: "run.completed",
            payload: {
              iteration,
              status: "stopped_by_tool",
              tool_name: toolCall.name,
            },
          });
          return {
            status: "stopped_by_tool",
            output,
            iterations: iteration,
            messages,
            events,
            stop_tool_name: stopToolName,
            last_tool_result: lastToolResult,
          };
        }
      }
    }

    emit({
      type: "run.completed",
      payload: {
        iteration: agent.max_iterations,
        status: "max_iterations_exceeded",
      },
    });

    return {
      status: "max_iterations_exceeded",
      output,
      iterations: agent.max_iterations,
      messages,
      events,
      stop_tool_name: stopToolName,
      last_tool_result: lastToolResult,
    };
  }
}
