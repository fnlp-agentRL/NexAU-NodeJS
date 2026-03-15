import type { AgentConfig } from "../../agent-config.js";
import { HybridToolSelector } from "./hybrid-selector.js";
import { PassthroughToolSelector } from "./passthrough-selector.js";
import type { ToolSelectorResolution } from "./types.js";

interface HookImportDefinition {
  import: string;
  params?: Record<string, unknown>;
}

type HookDefinition = string | HookImportDefinition;

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

function normalizeImportPath(value: string): string {
  return value.trim().toLowerCase();
}

function isSelectorImport(importPath: string): boolean {
  return importPath.includes("tool_selector") || importPath.includes("toolselector");
}

function isDisabled(params: Record<string, unknown>): boolean {
  return params.enabled === false;
}

export function resolveToolSelector(
  middlewares: AgentConfig["middlewares"],
): ToolSelectorResolution | null {
  if (!middlewares || middlewares.length === 0) {
    return null;
  }

  for (const definition of middlewares) {
    const hookImport = toHookImport(definition);
    const normalizedImport = normalizeImportPath(hookImport.import);
    if (!isSelectorImport(normalizedImport)) {
      continue;
    }

    if (isDisabled(hookImport.params ?? {})) {
      return null;
    }

    if (normalizedImport.includes("passthrough")) {
      return {
        mode: "passthrough",
        selector: new PassthroughToolSelector(),
        sourceImport: hookImport.import,
        enabled: true,
      };
    }

    if (normalizedImport.includes("hybrid") || normalizedImport.includes(":toolselector")) {
      return {
        mode: "hybrid",
        selector: new HybridToolSelector(hookImport.params ?? {}),
        sourceImport: hookImport.import,
        enabled: true,
      };
    }

    return {
      mode: "passthrough",
      selector: new PassthroughToolSelector(),
      sourceImport: hookImport.import,
      enabled: true,
      error: `Unsupported tool selector import: ${hookImport.import}`,
    };
  }

  return null;
}
