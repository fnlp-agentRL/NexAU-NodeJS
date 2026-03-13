import type { ToolAgentState, TodoItem } from "../types.js";

function asString(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === undefined || value === null) {
    return "";
  }
  throw new Error(`Parameter '${field}' must be a string-compatible value`);
}

function formatError(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (value === undefined || value === null) {
    return "Unknown error";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown error";
  }
}

function toPythonStyleMemoryJson(payload: {
  success: boolean;
  message?: string;
  error?: string;
}): string {
  const parts: string[] = [`"success": ${payload.success ? "true" : "false"}`];
  if (payload.message !== undefined) {
    parts.push(`"message": ${JSON.stringify(payload.message)}`);
  }
  if (payload.error !== undefined) {
    parts.push(`"error": ${JSON.stringify(payload.error)}`);
  }
  return `{${parts.join(", ")}}`;
}

function getAgentState(params: Record<string, unknown>): ToolAgentState {
  const state = params.agent_state;
  if (!state || typeof state !== "object") {
    return {};
  }
  return state as ToolAgentState;
}

export async function writeTodosTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const todos = (Array.isArray(params.todos) ? params.todos : []) as TodoItem[];
  const agentState = getAgentState(params);

  agentState.todos = todos;

  return {
    todos,
    count: todos.length,
  };
}

export async function saveMemoryTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fact = asString(params.fact, "fact");
  const agentState = getAgentState(params);

  if (!agentState.memory) {
    agentState.memory = [];
  }
  agentState.memory.push(fact);

  return {
    saved: true,
    fact,
    memory_count: agentState.memory.length,
  };
}

export async function saveMemoryCompatTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fact = asString(params.fact, "fact");
  const result = await saveMemoryTool(params);
  if (result.error) {
    const message = formatError(result.error);
    return {
      content: toPythonStyleMemoryJson({
        success: false,
        error: `Failed to save memory. Detail: ${message}`,
      }),
    };
  }

  return {
    content: toPythonStyleMemoryJson({
      success: true,
      message: `Okay, I've remembered that: "${fact}"`,
    }),
  };
}

export async function askUserTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const questions = Array.isArray(params.questions) ? params.questions : [];

  return {
    action: "ask_user",
    questions,
  };
}

export async function completeTaskTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return {
    completed: true,
    result: asString(params.result, "result"),
  };
}
