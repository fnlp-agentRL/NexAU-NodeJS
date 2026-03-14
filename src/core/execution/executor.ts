import { randomUUID } from "node:crypto";

import type { AgentConfig } from "../agent-config.js";
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

function renderSystemPrompt(agent: AgentConfig): string | null {
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
}

function normalizeToolCalls(response: LLMResponse): ToolCall[] {
  return (response.tool_calls ?? []).map((call) => ({
    id: call.id || randomUUID(),
    name: call.name,
    arguments: call.arguments ?? {},
  }));
}

function serializeToolPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
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

function buildStructuredToolPayload(agent: AgentConfig): Array<Record<string, unknown>> {
  return agent.tools.map((tool) => {
    const payload = tool.toOpenAI();
    const fn = payload.function;
    if (fn && typeof fn === "object") {
      return {
        ...payload,
        function: {
          ...fn,
          description: resolveStructuredToolDescription(tool),
        },
      };
    }
    return payload;
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
    const middlewares = resolveExecutionMiddlewares(options.agent.middlewares);
    const context: ExecutionMiddlewareContext = {
      agent: options.agent,
      input: options.input,
      history: options.history ? [...options.history] : [],
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
    const llmClient: LLMClient = this.deps.createLLMClient(agent);

    const messages: ChatMessage[] = [];
    const systemPrompt = renderSystemPrompt(agent);
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
    const agentState = context.agentState;
    const contextCompaction = resolveContextCompactionOptions(agent.middlewares);

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

      const tools = buildStructuredToolPayload(agent);

      emit({
        type: "llm.requested",
        payload: {
          iteration,
          message_count: messages.length,
          tool_count: tools.length,
        },
      });

      let response: LLMResponse;
      try {
        ensureNotInterrupted(signal);
        response = await withRetryAndTimeout(
          () => llmClient.complete({ agent, messages, tools }),
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

      const toolCalls = normalizeToolCalls(response);

      output = response.content;
      const assistantContent =
        toolCalls.length > 0 && response.content.length === 0 ? "null" : response.content;
      messages.push({
        role: "assistant",
        content: assistantContent,
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
        lastToolResult = toolResult;

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: serializeToolPayload(toolResult),
        });

        emit({
          type: "tool.completed",
          payload: {
            iteration,
            tool_name: toolCall.name,
            tool_call_id: toolCall.id,
            has_error: "error" in toolResult,
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
