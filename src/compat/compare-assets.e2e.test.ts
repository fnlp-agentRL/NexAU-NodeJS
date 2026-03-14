import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

describe("asset parity comparison script", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when structured files are semantically equal", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-asset-parity-pass-"));
    tempDirs.push(root);
    const baselineRoot = join(root, "baseline");
    const nodeRoot = join(root, "node");
    const outputDir = join(root, "report");

    writeFile(
      join(baselineRoot, "examples", "agent.yaml"),
      ["type: agent", "name: demo", "llm_config:", "  model: test-model"].join("\n"),
    );
    writeFile(
      join(nodeRoot, "examples", "agent.yaml"),
      "name: demo\nllm_config:\n  model: test-model\ntype: agent\n",
    );
    writeFile(join(baselineRoot, "examples", "notes.md"), "baseline notes");
    writeFile(join(nodeRoot, "examples", "notes.md"), "node notes");

    const scriptPath = resolve(process.cwd(), "compat/parity/cross-framework/compare_assets.mjs");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--baseline-root",
        baselineRoot,
        "--node-root",
        nodeRoot,
        "--output-dir",
        outputDir,
        "--check",
      ],
      {
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      overall_passed: boolean;
      latest_json: string;
    };
    expect(payload.overall_passed).toBe(true);
    const latest = JSON.parse(readFileSync(payload.latest_json, "utf-8")) as {
      summary: {
        structured_semantic_diff_count: number;
        unstructured_content_diff_count: number;
        unstructured_strict_violation_count: number;
      };
      unstructured_by_category: Record<string, number>;
    };
    expect(latest.summary.structured_semantic_diff_count).toBe(0);
    expect(latest.summary.unstructured_content_diff_count).toBe(1);
    expect(latest.summary.unstructured_strict_violation_count).toBe(0);
    expect(latest.unstructured_by_category.markdown_or_text).toBe(1);
  });

  it("fails when structured semantics differ", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-asset-parity-fail-"));
    tempDirs.push(root);
    const baselineRoot = join(root, "baseline");
    const nodeRoot = join(root, "node");
    const outputDir = join(root, "report");

    writeFile(join(baselineRoot, "examples", "agent.yaml"), "type: agent\nname: baseline\n");
    writeFile(join(nodeRoot, "examples", "agent.yaml"), "type: agent\nname: node\n");

    const scriptPath = resolve(process.cwd(), "compat/parity/cross-framework/compare_assets.mjs");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--baseline-root",
        baselineRoot,
        "--node-root",
        nodeRoot,
        "--output-dir",
        outputDir,
        "--check",
      ],
      {
        encoding: "utf-8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Asset parity gate failed");
  });

  it("fails in strict unstructured mode", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-asset-parity-strict-unstructured-"));
    tempDirs.push(root);
    const baselineRoot = join(root, "baseline");
    const nodeRoot = join(root, "node");
    const outputDir = join(root, "report");

    writeFile(join(baselineRoot, "examples", "agent.yaml"), "type: agent\nname: same\n");
    writeFile(join(nodeRoot, "examples", "agent.yaml"), "type: agent\nname: same\n");
    writeFile(join(baselineRoot, "examples", "notes.md"), "baseline notes");
    writeFile(join(nodeRoot, "examples", "notes.md"), "node notes");

    const scriptPath = resolve(process.cwd(), "compat/parity/cross-framework/compare_assets.mjs");
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--baseline-root",
        baselineRoot,
        "--node-root",
        nodeRoot,
        "--output-dir",
        outputDir,
        "--strict-unstructured",
        "--check",
      ],
      {
        encoding: "utf-8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unstructured_strict_violations=1");
  });

  it("supports prefix-based strict mode for unstructured diffs", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-asset-parity-prefix-"));
    tempDirs.push(root);
    const baselineRoot = join(root, "baseline");
    const nodeRoot = join(root, "node");
    const outputDir = join(root, "report");

    writeFile(join(baselineRoot, "examples", "skills", "doc.md"), "baseline doc");
    writeFile(join(nodeRoot, "examples", "skills", "doc.md"), "node doc");
    writeFile(join(baselineRoot, "examples", "notes.md"), "baseline notes");
    writeFile(join(nodeRoot, "examples", "notes.md"), "node notes");

    const scriptPath = resolve(process.cwd(), "compat/parity/cross-framework/compare_assets.mjs");
    const strictHit = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--baseline-root",
        baselineRoot,
        "--node-root",
        nodeRoot,
        "--output-dir",
        outputDir,
        "--strict-unstructured-prefixes",
        "skills",
        "--check",
      ],
      {
        encoding: "utf-8",
      },
    );
    expect(strictHit.status).not.toBe(0);
    expect(strictHit.stderr).toContain("unstructured_strict_violations=1");

    const strictMiss = spawnSync(
      process.execPath,
      [
        scriptPath,
        "--baseline-root",
        baselineRoot,
        "--node-root",
        nodeRoot,
        "--output-dir",
        outputDir,
        "--strict-unstructured-prefixes",
        "frontend",
        "--check",
      ],
      {
        encoding: "utf-8",
      },
    );
    expect(strictMiss.status).toBe(0);
  });
});
