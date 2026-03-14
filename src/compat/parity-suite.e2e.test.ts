import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

describe("parity suite report", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes with skip flags and exposes summary fields", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-parity-suite-skip-"));
    tempDirs.push(root);
    const outputDir = join(root, "suite-output");

    const scriptPath = resolve(process.cwd(), "compat/parity/cross-framework/run_parity_suite.mjs");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--output-dir",
        outputDir,
        "--check",
        "--failures-only",
        "--skip-if-baseline-missing",
        "--python-bin",
        join(root, "missing-python"),
        "--baseline-root",
        join(root, "missing-baseline"),
      ],
      {
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    const stdoutJson = JSON.parse(result.stdout.trim()) as {
      latest_json: string;
      overall_passed: boolean;
      runtime: { skipped: boolean };
      assets: { skipped: boolean };
    };
    expect(stdoutJson.overall_passed).toBe(true);
    expect(stdoutJson.runtime.skipped).toBe(true);
    expect(stdoutJson.assets.skipped).toBe(true);

    const suitePayload = JSON.parse(readFileSync(stdoutJson.latest_json, "utf-8")) as {
      runtime: {
        skipped: boolean;
        summary: { scenario_count: number };
      };
      assets: {
        skipped: boolean;
        summary: { structured_semantic_diff_count: number };
      };
      overall_passed: boolean;
    };
    expect(suitePayload.overall_passed).toBe(true);
    expect(suitePayload.runtime.skipped).toBe(true);
    expect(suitePayload.runtime.summary.scenario_count).toBe(0);
    expect(suitePayload.assets.skipped).toBe(true);
    expect(suitePayload.assets.summary.structured_semantic_diff_count).toBe(0);
    expect(
      Array.isArray((suitePayload as { failure_highlights?: unknown[] }).failure_highlights),
    ).toBe(true);

    const markdown = readFileSync(join(outputDir, "latest-suite.md"), "utf-8");
    expect(markdown).toContain("Failure-First Summary");
    expect(markdown).toContain("No failures detected.");
    expect(markdown).not.toContain("Runtime Summary");
  });

  it("fails suite gate when strict unstructured asset diff exists", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-parity-suite-fail-"));
    tempDirs.push(root);
    const baselineRoot = join(root, "baseline");
    const nodeRoot = join(root, "node");
    const outputDir = join(root, "suite-output");

    writeFile(join(baselineRoot, "examples", "agent.yaml"), "type: agent\nname: same\n");
    writeFile(join(nodeRoot, "examples", "agent.yaml"), "type: agent\nname: same\n");
    writeFile(join(baselineRoot, "examples", "docs", "guide.md"), "baseline docs");
    writeFile(join(nodeRoot, "examples", "docs", "guide.md"), "node docs");

    const scriptPath = resolve(process.cwd(), "compat/parity/cross-framework/run_parity_suite.mjs");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--output-dir",
        outputDir,
        "--check",
        "--failures-only",
        "--skip-if-baseline-missing",
        "--python-bin",
        join(root, "missing-python"),
        "--baseline-root",
        baselineRoot,
        "--node-root",
        nodeRoot,
        "--strict-unstructured",
      ],
      {
        encoding: "utf-8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Parity suite gate failed");
    expect(result.stdout).toContain("failure_highlights");

    const latest = JSON.parse(readFileSync(join(outputDir, "latest-suite.json"), "utf-8")) as {
      failure_highlights: string[];
    };
    expect(
      latest.failure_highlights.some((item) => item.includes("unstructured_strict_violations")),
    ).toBe(true);
  });
});
