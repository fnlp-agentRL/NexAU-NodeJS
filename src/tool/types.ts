export type ToolResultScalar = string | number | boolean | null | undefined;
export type ToolResult = ToolResultScalar | Record<string, unknown> | Array<unknown>;

export interface TodoItem {
  description: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface ToolAgentState {
  todos?: TodoItem[];
  memory?: string[];
  global_storage?: Record<string, unknown>;
}

export type ToolImplementation = (
  params: Record<string, unknown>,
) => ToolResult | Promise<ToolResult>;
