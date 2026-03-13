import { describe, expect, it } from "vitest";

import { ConfigError } from "../core/config-error.js";
import {
  replaceEnvTemplates,
  replaceThisFileDir,
  replaceVariableTemplates,
} from "./env-template.js";

describe("env template replacement", () => {
  it("replaces this_file_dir placeholders", () => {
    expect(replaceThisFileDir("root=${this_file_dir}/tmp", "/tmp/work")).toBe("root=/tmp/work/tmp");
  });

  it("replaces env placeholders", () => {
    const output = replaceEnvTemplates("key=${env.TEST_KEY}", { TEST_KEY: "abc123" });
    expect(output).toBe("key=abc123");
  });

  it("throws when env variable is missing", () => {
    expect(() => replaceEnvTemplates("key=${env.MISSING}", {})).toThrowError(ConfigError);
    expect(() => replaceEnvTemplates("key=${env.MISSING}", {})).toThrow(
      "Environment variable 'MISSING' is not set",
    );
  });

  it("resolves nested variables", () => {
    const output = replaceVariableTemplates("name=${variables.project.name}", {
      project: {
        name: "nexau",
      },
    });
    expect(output).toBe("name=nexau");
  });

  it("throws for non-scalar variables", () => {
    expect(() =>
      replaceVariableTemplates("x=${variables.project}", {
        project: {
          nested: true,
        },
      }),
    ).toThrow(
      "Variable 'project' resolves to a non-scalar value and cannot be embedded in a string",
    );
  });
});
