import type { ToolSelector, ToolSelectorInput, ToolSelectorResult } from "./types.js";

export class PassthroughToolSelector implements ToolSelector {
  public select(input: ToolSelectorInput): ToolSelectorResult {
    return {
      selectedToolNames: input.tools.map((tool) => tool.name),
      trace: {
        mode: "passthrough",
        selected_count: input.tools.length,
        total_count: input.tools.length,
      },
    };
  }
}
