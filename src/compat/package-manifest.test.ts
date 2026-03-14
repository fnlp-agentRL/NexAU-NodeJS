import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("package manifest", () => {
  it("exposes dist entrypoint for git dependency consumers", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = resolve(currentDir, "../../package.json");
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      main?: string;
      types?: string;
      exports?: {
        [key: string]:
          | {
              import?: string;
              types?: string;
            }
          | undefined;
      };
    };

    expect(manifest.main).toBe("dist/index.js");
    expect(manifest.types).toBe("dist/index.d.ts");
    expect(manifest.exports?.["."]?.import).toBe("./dist/index.js");
    expect(manifest.exports?.["."]?.types).toBe("./dist/index.d.ts");
  });
});
