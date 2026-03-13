import { ConfigError } from "./config-error.js";

export const DEFAULT_TOOL_CALL_MODE = "openai" as const;
export const VALID_TOOL_CALL_MODES = ["xml", "openai", "anthropic"] as const;

export type ToolCallMode = (typeof VALID_TOOL_CALL_MODES)[number];

export function normalizeToolCallMode(mode?: string | null): ToolCallMode {
  const normalized = (mode ?? DEFAULT_TOOL_CALL_MODE).toLowerCase();
  if (!VALID_TOOL_CALL_MODES.includes(normalized as ToolCallMode)) {
    throw new ConfigError("tool_call_mode must be one of 'xml', 'openai', or 'anthropic'");
  }
  return normalized as ToolCallMode;
}
