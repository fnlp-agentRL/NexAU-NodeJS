import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("cross-framework scenario dataset", () => {
  it("contains required runtime parity scenarios with deterministic shape", () => {
    const datasetPath = resolve(
      process.cwd(),
      "compat/parity/cross-framework/datasets/scenarios.json",
    );
    const scenarios = JSON.parse(readFileSync(datasetPath, "utf-8")) as Record<string, unknown>;

    const requiredScenarioNames = [
      "prompt_toolcall",
      "prompt_toolcall_extended",
      "load_skill_toolcall",
      "long_output_toolcall",
      "alias_toolcall",
      "error_toolcall",
      "long_context",
    ];

    for (const scenarioName of requiredScenarioNames) {
      const scenario = scenarios[scenarioName] as
        | {
            name?: string;
            responses?: Array<{
              tool_calls?: Array<{
                name?: string;
                arguments?: Record<string, unknown>;
              }>;
            }>;
          }
        | undefined;
      expect(scenario).toBeTruthy();
      expect(scenario?.name).toBe(scenarioName);
      expect(Array.isArray(scenario?.responses)).toBe(true);
      expect((scenario?.responses ?? []).length).toBeGreaterThan(0);
    }

    const longOutputScenario = scenarios.long_output_toolcall as {
      responses: Array<{
        tool_calls?: Array<{
          name?: string;
          arguments?: Record<string, unknown>;
        }>;
      }>;
    };
    const firstResponse = longOutputScenario.responses[0];
    const firstToolCall = firstResponse?.tool_calls?.[0];
    expect(firstToolCall?.name).toBe("read_file");
    expect(String(firstToolCall?.arguments?.file_path ?? "")).toContain("long_output_notes.md");
  });
});
