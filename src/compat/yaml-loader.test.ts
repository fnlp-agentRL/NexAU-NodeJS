import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError } from "../core/config-error.js";
import { loadYamlWithVars } from "./yaml-loader.js";

describe("loadYamlWithVars", () => {
  it("loads yaml with this_file_dir, env and variables substitution", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-yaml-loader-"));
    const yamlPath = join(dir, "agent.yaml");

    writeFileSync(
      yamlPath,
      [
        "root_dir: ${this_file_dir}",
        "api_key: ${env.TEST_API_KEY}",
        "variables:",
        "  project:",
        "    name: NexAU",
        "message: Hello ${variables.project.name}",
      ].join("\n"),
    );

    const loaded = loadYamlWithVars(yamlPath, {
      env: {
        TEST_API_KEY: "test-key",
      },
    }) as Record<string, unknown>;

    expect(loaded.root_dir).toBe(dir);
    expect(loaded.api_key).toBe("test-key");
    expect(loaded.message).toBe("Hello NexAU");
    expect(loaded.variables).toBeUndefined();
  });

  it("throws when variables is not a mapping", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-yaml-loader-invalid-vars-"));
    const yamlPath = join(dir, "agent.yaml");
    writeFileSync(yamlPath, ["variables:", "  - not_a_map"].join("\n"));

    expect(() => loadYamlWithVars(yamlPath, {})).toThrowError(ConfigError);
    expect(() => loadYamlWithVars(yamlPath, {})).toThrow(
      "'variables' must be a mapping if provided in YAML",
    );
  });
});
