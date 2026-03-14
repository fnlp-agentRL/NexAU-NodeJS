import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("parity diagnose script", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts failed fragments from provided suite json", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-parity-diagnose-fixture-"));
    tempDirs.push(root);

    const runtimePath = join(root, "runtime.json");
    const assetsPath = join(root, "assets.json");
    const suitePath = join(root, "suite.json");

    writeJson(runtimePath, {
      prompt_cases: [
        {
          scenario: "s1",
          passed: false,
          prompt_input_compare: { equal: false },
          tool_call_compare: { equal: true, details: [{ iteration: 1, same: false }] },
          output_compare: { equal: true },
        },
      ],
    });
    writeJson(assetsPath, {
      structured_semantic_diff: ["examples/a.yaml"],
      unstructured_strict_violations: ["examples/docs/guide.md"],
    });
    writeJson(suitePath, {
      overall_passed: false,
      failure_highlights: ["runtime: scenario failed: s1", "assets: structured_semantic_diff=1"],
      runtime: {
        skipped: false,
        detail: "overall_passed=false; scenarios=1; failed=1",
        latest_json: runtimePath,
        summary: {
          long_context: { compaction_delta: 1, final_message_delta: 0 },
          scenario_breakdown: [
            {
              scenario: "s1",
              passed: false,
              prompt_equal: false,
              tool_call_equal: true,
              output_equal: true,
            },
          ],
        },
      },
      assets: {
        skipped: false,
        detail: "overall_passed=false; structured_diffs=1; strict_violations=1",
        latest_json: assetsPath,
        summary: {
          missing_in_node_count: 0,
          extra_in_node_count: 0,
          structured_semantic_diff_count: 1,
          unstructured_content_diff_count: 1,
          unstructured_strict_violation_count: 1,
          unstructured_by_category: { skills_docs: 1 },
          sample_structured_diffs: ["examples/a.yaml"],
          sample_unstructured_strict_violations: ["examples/docs/guide.md"],
        },
      },
    });

    const scriptPath = resolve(
      process.cwd(),
      "compat/parity/cross-framework/diagnose_failures.mjs",
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--suite-json", suitePath, "--max-items", "1"],
      {
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      overall_passed: boolean;
      failure_highlights: string[];
      runtime: { failed_scenarios: Array<{ scenario: string }> };
      assets: {
        structured_diff_samples: string[];
        strict_violation_samples: string[];
        raw_structured_diff_samples: string[];
      };
    };
    expect(payload.overall_passed).toBe(false);
    expect(payload.failure_highlights.length).toBe(1);
    expect(payload.failure_highlights[0]).toContain("runtime");
    expect(payload.runtime.failed_scenarios[0]?.scenario).toBe("s1");
    expect(payload.assets.structured_diff_samples[0]).toBe("examples/a.yaml");
    expect(payload.assets.strict_violation_samples[0]).toBe("examples/docs/guide.md");
    expect(payload.assets.raw_structured_diff_samples[0]).toBe("examples/a.yaml");
  });

  it("supports compact triage output", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-parity-diagnose-compact-"));
    tempDirs.push(root);
    const suitePath = join(root, "suite.json");

    writeJson(suitePath, {
      overall_passed: false,
      failure_highlights: ["runtime: scenario failed: s1"],
      runtime: {
        skipped: false,
        detail: "overall_passed=false",
        latest_json: null,
        summary: {
          scenario_breakdown: [
            {
              scenario: "s1",
              passed: false,
              prompt_equal: false,
              tool_call_equal: false,
              output_equal: true,
            },
          ],
          long_context: {
            compaction_delta: 0,
            final_message_delta: 0,
          },
        },
      },
      assets: {
        skipped: false,
        detail: "overall_passed=true",
        latest_json: null,
        summary: {
          missing_in_node_count: 0,
          extra_in_node_count: 0,
          structured_semantic_diff_count: 0,
          unstructured_content_diff_count: 0,
          unstructured_strict_violation_count: 0,
        },
      },
    });

    const scriptPath = resolve(
      process.cwd(),
      "compat/parity/cross-framework/diagnose_failures.mjs",
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--suite-json", suitePath, "--compact"],
      {
        encoding: "utf-8",
      },
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      overall_passed: boolean;
      failure_highlights: string[];
      runtime_failed_scenarios: Array<{ scenario: string }>;
      asset_summary: { structured_semantic_diff_count: number };
    };
    expect(payload.overall_passed).toBe(false);
    expect(payload.failure_highlights[0]).toContain("runtime");
    expect(payload.runtime_failed_scenarios[0]?.scenario).toBe("s1");
    expect(payload.asset_summary.structured_semantic_diff_count).toBe(0);
  });

  it("can run suite automatically with skip flags", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-parity-diagnose-run-"));
    tempDirs.push(root);
    const outputDir = join(root, "out");
    const scriptPath = resolve(
      process.cwd(),
      "compat/parity/cross-framework/diagnose_failures.mjs",
    );

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--output-dir",
        outputDir,
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
    const payload = JSON.parse(result.stdout) as {
      reports: { suite: string };
      runtime: { skipped: boolean };
      assets: { skipped: boolean };
    };
    expect(payload.runtime.skipped).toBe(true);
    expect(payload.assets.skipped).toBe(true);
    expect(readFileSync(payload.reports.suite, "utf-8")).toContain('"overall_passed": true');
  });
});
