import type { Tool } from "../../../tool/tool.js";
import type { ChatMessage } from "../types.js";

export interface ToolSelectorInput {
  query: string;
  messages: ChatMessage[];
  tools: Tool[];
  agentState: Record<string, unknown>;
  iteration: number;
}

export interface ToolSelectorResult {
  selectedToolNames: string[];
  trace: Record<string, unknown>;
}

export interface ToolSelector {
  select(input: ToolSelectorInput): Promise<ToolSelectorResult> | ToolSelectorResult;
}

export interface ToolSelectorResolution {
  mode: "hybrid" | "passthrough";
  selector: ToolSelector;
  sourceImport: string;
  enabled: boolean;
  error?: string;
}
