#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const THIS_DIR = dirname(new URL(import.meta.url).pathname);

function parseArgs(argv) {
  const options = {
    suiteJson: "",
    maxItems: 10,
    outputDir: "",
    skipIfBaselineMissing: false,
    pythonBin: "",
    promptScenarios: "",
    longScenario: "",
    maxCompactionDelta: "",
    maxFinalMessageDelta: "",
    baselineRoot: "",
    nodeRoot: "",
    subdir: "",
    strictExtra: false,
    strictUnstructured: false,
    strictUnstructuredPrefixes: "",
    compact: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--suite-json":
        options.suiteJson = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--max-items": {
        const raw = argv[i + 1] ?? "10";
        i += 1;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error(`Invalid --max-items value: ${raw}`);
        }
        options.maxItems = Math.floor(parsed);
        break;
      }
      case "--output-dir":
        options.outputDir = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--skip-if-baseline-missing":
        options.skipIfBaselineMissing = true;
        break;
      case "--python-bin":
        options.pythonBin = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--prompt-scenarios":
        options.promptScenarios = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--long-scenario":
        options.longScenario = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--max-compaction-delta":
        options.maxCompactionDelta = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--max-final-message-delta":
        options.maxFinalMessageDelta = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--baseline-root":
        options.baselineRoot = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--node-root":
        options.nodeRoot = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--subdir":
        options.subdir = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--strict-extra":
        options.strictExtra = true;
        break;
      case "--strict-unstructured":
        options.strictUnstructured = true;
        break;
      case "--strict-unstructured-prefixes":
        options.strictUnstructuredPrefixes = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--compact":
        options.compact = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseLastJson(stdout) {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  throw new Error(`No JSON object found in stdout:\n${stdout}`);
}

function runSuiteAndGetPath(options) {
  const args = [join(THIS_DIR, "run_parity_suite.mjs"), "--failures-only"];
  if (options.outputDir) {
    args.push("--output-dir", options.outputDir);
  }
  if (options.skipIfBaselineMissing) {
    args.push("--skip-if-baseline-missing");
  }
  if (options.pythonBin) {
    args.push("--python-bin", options.pythonBin);
  }
  if (options.promptScenarios) {
    args.push("--prompt-scenarios", options.promptScenarios);
  }
  if (options.longScenario) {
    args.push("--long-scenario", options.longScenario);
  }
  if (options.maxCompactionDelta) {
    args.push("--max-compaction-delta", options.maxCompactionDelta);
  }
  if (options.maxFinalMessageDelta) {
    args.push("--max-final-message-delta", options.maxFinalMessageDelta);
  }
  if (options.baselineRoot) {
    args.push("--baseline-root", options.baselineRoot);
  }
  if (options.nodeRoot) {
    args.push("--node-root", options.nodeRoot);
  }
  if (options.subdir) {
    args.push("--subdir", options.subdir);
  }
  if (options.strictExtra) {
    args.push("--strict-extra");
  }
  if (options.strictUnstructured) {
    args.push("--strict-unstructured");
  }
  if (options.strictUnstructuredPrefixes) {
    args.push("--strict-unstructured-prefixes", options.strictUnstructuredPrefixes);
  }

  const result = spawnSync(process.execPath, args, {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to run parity suite: ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  const meta = parseLastJson(result.stdout);
  const path = String(meta.latest_json ?? "");
  if (path.length === 0) {
    throw new Error("Parity suite output missing latest_json");
  }
  return path;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function sliceSafe(items, maxItems) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.slice(0, maxItems);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const suiteJsonPath = options.suiteJson || runSuiteAndGetPath(options);
  if (!existsSync(suiteJsonPath)) {
    throw new Error(`Suite report not found: ${suiteJsonPath}`);
  }

  const suite = loadJson(suiteJsonPath);
  const runtimeReportPath = String(suite?.runtime?.latest_json ?? "");
  const assetReportPath = String(suite?.assets?.latest_json ?? "");
  const runtimeReport =
    runtimeReportPath && existsSync(runtimeReportPath) ? loadJson(runtimeReportPath) : null;
  const assetReport =
    assetReportPath && existsSync(assetReportPath) ? loadJson(assetReportPath) : null;

  const runtimeFailedScenarios = sliceSafe(
    suite?.runtime?.summary?.scenario_breakdown,
    options.maxItems,
  )
    .filter((item) => !item?.passed)
    .map((item) => ({
      scenario: item?.scenario ?? "unknown",
      prompt_equal: Boolean(item?.prompt_equal),
      tool_call_equal: Boolean(item?.tool_call_equal),
      output_equal: Boolean(item?.output_equal),
    }));

  const runtimeFailedDetails = runtimeReport
    ? sliceSafe(runtimeReport?.prompt_cases, options.maxItems)
        .filter((item) => !item?.passed)
        .map((item) => ({
          scenario: item?.scenario ?? "unknown",
          prompt_equal: Boolean(item?.prompt_input_compare?.equal),
          tool_call_equal: Boolean(item?.tool_call_compare?.equal),
          output_equal: Boolean(item?.output_compare?.equal),
          tool_call_details: sliceSafe(item?.tool_call_compare?.details, options.maxItems),
        }))
    : [];

  const assetSummary = suite?.assets?.summary ?? {};
  const output = {
    generated_at: new Date().toISOString(),
    suite_json: suiteJsonPath,
    overall_passed: Boolean(suite?.overall_passed),
    failure_highlights: sliceSafe(suite?.failure_highlights, options.maxItems),
    runtime: {
      skipped: Boolean(suite?.runtime?.skipped),
      detail: String(suite?.runtime?.detail ?? ""),
      failed_scenarios: runtimeFailedScenarios,
      failed_details: runtimeFailedDetails,
      long_context: {
        compaction_delta: Number(suite?.runtime?.summary?.long_context?.compaction_delta ?? 0),
        final_message_delta: Number(
          suite?.runtime?.summary?.long_context?.final_message_delta ?? 0,
        ),
      },
    },
    assets: {
      skipped: Boolean(suite?.assets?.skipped),
      detail: String(suite?.assets?.detail ?? ""),
      summary: {
        missing_in_node_count: Number(assetSummary?.missing_in_node_count ?? 0),
        extra_in_node_count: Number(assetSummary?.extra_in_node_count ?? 0),
        structured_semantic_diff_count: Number(assetSummary?.structured_semantic_diff_count ?? 0),
        unstructured_content_diff_count: Number(assetSummary?.unstructured_content_diff_count ?? 0),
        unstructured_strict_violation_count: Number(
          assetSummary?.unstructured_strict_violation_count ?? 0,
        ),
      },
      category_counts: assetSummary?.unstructured_by_category ?? {},
      structured_diff_samples: sliceSafe(assetSummary?.sample_structured_diffs, options.maxItems),
      strict_violation_samples: sliceSafe(
        assetSummary?.sample_unstructured_strict_violations,
        options.maxItems,
      ),
      raw_structured_diff_samples: sliceSafe(
        assetReport?.structured_semantic_diff,
        options.maxItems,
      ),
      raw_strict_violation_samples: sliceSafe(
        assetReport?.unstructured_strict_violations,
        options.maxItems,
      ),
    },
    reports: {
      suite: suiteJsonPath,
      runtime: runtimeReportPath || null,
      assets: assetReportPath || null,
    },
  };

  if (options.compact) {
    const compactOutput = {
      overall_passed: output.overall_passed,
      failure_highlights: output.failure_highlights,
      runtime_failed_scenarios: output.runtime.failed_scenarios,
      asset_summary: output.assets.summary,
      reports: output.reports,
    };
    process.stdout.write(`${JSON.stringify(compactOutput, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
