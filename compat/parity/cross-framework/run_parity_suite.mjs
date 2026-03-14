#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const THIS_DIR = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = resolve(THIS_DIR, "../../..");

function parseArgs(argv) {
  const options = {
    outputDir: "",
    check: false,
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
    failuresOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--output-dir":
        options.outputDir = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--check":
        options.check = true;
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
      case "--failures-only":
        options.failuresOnly = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function ensureDir(path) {
  const target = path ? resolve(path) : resolve(tmpdir(), `nexau-parity-suite-${Date.now()}`);
  mkdirSync(target, { recursive: true });
  return target;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
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

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status}): ${command} ${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  return parseLastJson(result.stdout);
}

function loadRuntimePayload(meta) {
  if (!meta || meta.skipped || !meta.latest_json) {
    return null;
  }
  return JSON.parse(readFileSync(meta.latest_json, "utf-8"));
}

function loadAssetPayload(meta) {
  if (!meta || meta.skipped || !meta.latest_json) {
    return null;
  }
  return JSON.parse(readFileSync(meta.latest_json, "utf-8"));
}

function buildRuntimeSummary(runtimePayload) {
  if (!runtimePayload) {
    return {
      scenario_count: 0,
      failed_scenarios: [],
      long_context: {
        compaction_delta: 0,
        final_message_delta: 0,
      },
      timing: {
        framework_overhead_ms: {
          python: 0,
          node: 0,
        },
        prompt_assembly_ms: {
          python: 0,
          node: 0,
        },
        tool_execution_ms: {
          python: 0,
          node: 0,
        },
      },
      scenario_breakdown: [],
    };
  }

  const promptCases = Array.isArray(runtimePayload.prompt_cases) ? runtimePayload.prompt_cases : [];
  const failedScenarios = [];
  const scenarioBreakdown = [];

  for (const item of promptCases) {
    const passed = Boolean(item?.passed);
    const scenario = String(item?.scenario ?? "unknown");
    if (!passed) {
      failedScenarios.push(scenario);
    }
    scenarioBreakdown.push({
      scenario,
      passed,
      prompt_equal: Boolean(item?.prompt_input_compare?.equal),
      tool_call_equal: Boolean(item?.tool_call_compare?.equal),
      output_equal: Boolean(item?.output_compare?.equal),
    });
  }

  const timing = runtimePayload?.overall?.prompt_timing_aggregate ?? {};
  return {
    scenario_count: promptCases.length,
    failed_scenarios: failedScenarios,
    long_context: {
      compaction_delta: asNumber(runtimePayload?.overall?.long_context_compaction_delta),
      final_message_delta: asNumber(runtimePayload?.overall?.long_context_final_message_delta),
    },
    timing: {
      framework_overhead_ms: {
        python: asNumber(timing?.python?.framework_overhead_ms),
        node: asNumber(timing?.node?.framework_overhead_ms),
      },
      prompt_assembly_ms: {
        python: asNumber(timing?.python?.prompt_assembly_ms),
        node: asNumber(timing?.node?.prompt_assembly_ms),
      },
      tool_execution_ms: {
        python: asNumber(timing?.python?.tool_execution_ms),
        node: asNumber(timing?.node?.tool_execution_ms),
      },
    },
    scenario_breakdown: scenarioBreakdown,
  };
}

function buildAssetSummary(assetPayload) {
  if (!assetPayload) {
    return {
      missing_in_node_count: 0,
      extra_in_node_count: 0,
      structured_semantic_diff_count: 0,
      unstructured_content_diff_count: 0,
      unstructured_strict_violation_count: 0,
      unstructured_by_category: {},
      sample_structured_diffs: [],
      sample_unstructured_strict_violations: [],
    };
  }

  const summary = assetPayload.summary ?? {};
  const structuredSemanticDiff = Array.isArray(assetPayload.structured_semantic_diff)
    ? assetPayload.structured_semantic_diff
    : [];
  const strictViolations = Array.isArray(assetPayload.unstructured_strict_violations)
    ? assetPayload.unstructured_strict_violations
    : [];
  const categories =
    assetPayload.unstructured_by_category &&
    typeof assetPayload.unstructured_by_category === "object"
      ? assetPayload.unstructured_by_category
      : {};

  return {
    missing_in_node_count: asNumber(summary.missing_in_node_count),
    extra_in_node_count: asNumber(summary.extra_in_node_count),
    structured_semantic_diff_count: asNumber(summary.structured_semantic_diff_count),
    unstructured_content_diff_count: asNumber(summary.unstructured_content_diff_count),
    unstructured_strict_violation_count: asNumber(summary.unstructured_strict_violation_count),
    unstructured_by_category: categories,
    sample_structured_diffs: structuredSemanticDiff.slice(0, 10),
    sample_unstructured_strict_violations: strictViolations.slice(0, 10),
  };
}

function buildRuntimeDetail(runtimePassed, runtimeSummary) {
  const failedCount = runtimeSummary.failed_scenarios.length;
  return `overall_passed=${runtimePassed}; scenarios=${runtimeSummary.scenario_count}; failed=${failedCount}`;
}

function buildAssetDetail(assetsPassed, assetSummary) {
  return `overall_passed=${assetsPassed}; structured_diffs=${assetSummary.structured_semantic_diff_count}; strict_violations=${assetSummary.unstructured_strict_violation_count}`;
}

function collectFailureHighlights(payload) {
  const highlights = [];
  if (!payload.runtime.skipped) {
    for (const scenario of payload.runtime.summary.failed_scenarios) {
      highlights.push(`runtime: scenario failed: ${scenario}`);
    }
    if (payload.runtime.summary.long_context.compaction_delta !== 0) {
      highlights.push(
        `runtime: long_context compaction_delta=${payload.runtime.summary.long_context.compaction_delta}`,
      );
    }
    if (payload.runtime.summary.long_context.final_message_delta !== 0) {
      highlights.push(
        `runtime: long_context final_message_delta=${payload.runtime.summary.long_context.final_message_delta}`,
      );
    }
  }

  if (!payload.assets.skipped) {
    if (payload.assets.summary.missing_in_node_count > 0) {
      highlights.push(`assets: missing_in_node=${payload.assets.summary.missing_in_node_count}`);
    }
    if (payload.assets.summary.extra_in_node_count > 0) {
      highlights.push(`assets: extra_in_node=${payload.assets.summary.extra_in_node_count}`);
    }
    if (payload.assets.summary.structured_semantic_diff_count > 0) {
      highlights.push(
        `assets: structured_semantic_diff=${payload.assets.summary.structured_semantic_diff_count}`,
      );
      for (const relPath of payload.assets.summary.sample_structured_diffs.slice(0, 5)) {
        highlights.push(`assets: structured_diff_sample=${relPath}`);
      }
    }
    if (payload.assets.summary.unstructured_strict_violation_count > 0) {
      highlights.push(
        `assets: unstructured_strict_violations=${payload.assets.summary.unstructured_strict_violation_count}`,
      );
      for (const relPath of payload.assets.summary.sample_unstructured_strict_violations.slice(
        0,
        5,
      )) {
        highlights.push(`assets: strict_violation_sample=${relPath}`);
      }
    }
  }

  return highlights;
}

function buildMarkdownReport(payload) {
  const lines = [];
  lines.push("# Parity Suite Report");
  lines.push("");
  lines.push(`- Generated at: ${payload.generated_at}`);
  lines.push(`- Output dir: ${payload.config.output_dir}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Gate | Status | Detail |");
  lines.push("|---|---|---|");
  lines.push(
    `| Runtime parity | ${payload.runtime.skipped ? "skipped" : payload.runtime.passed ? "pass" : "fail"} | ${payload.runtime.detail} |`,
  );
  lines.push(
    `| Asset parity | ${payload.assets.skipped ? "skipped" : payload.assets.passed ? "pass" : "fail"} | ${payload.assets.detail} |`,
  );
  lines.push(`| Overall | ${payload.overall_passed ? "pass" : "fail"} | - |`);
  lines.push("");

  if (payload.config.failures_only) {
    lines.push("## Failure-First Summary");
    lines.push("");
    if (payload.failure_highlights.length === 0) {
      lines.push("- No failures detected.");
    } else {
      for (const item of payload.failure_highlights) {
        lines.push(`- ${item}`);
      }
    }
    lines.push("");
    lines.push("## Reports");
    lines.push("");
    lines.push(`- Runtime report: ${payload.runtime.latest_json ?? "(none)"}`);
    lines.push(`- Asset report: ${payload.assets.latest_json ?? "(none)"}`);
    lines.push(`- Suite JSON: ${payload.artifacts.json_report}`);
    lines.push(`- Suite Markdown: ${payload.artifacts.markdown_report}`);
    return lines.join("\n");
  }

  lines.push("## Runtime Summary");
  lines.push("");
  if (payload.runtime.skipped) {
    lines.push(`- skipped: ${payload.runtime.detail}`);
  } else {
    lines.push(`- prompt scenarios: ${payload.runtime.summary.scenario_count}`);
    lines.push(`- failed scenarios: ${payload.runtime.summary.failed_scenarios.length}`);
    lines.push(
      `- long-context deltas: compaction=${payload.runtime.summary.long_context.compaction_delta}, final_messages=${payload.runtime.summary.long_context.final_message_delta}`,
    );
    lines.push(
      `- overhead (ms): python=${payload.runtime.summary.timing.framework_overhead_ms.python.toFixed(3)}, node=${payload.runtime.summary.timing.framework_overhead_ms.node.toFixed(3)}`,
    );
    lines.push(
      `- prompt assembly (ms): python=${payload.runtime.summary.timing.prompt_assembly_ms.python.toFixed(3)}, node=${payload.runtime.summary.timing.prompt_assembly_ms.node.toFixed(3)}`,
    );
    lines.push("");
    lines.push("| Scenario | Passed | Prompt | ToolCall | Output |");
    lines.push("|---|---|---|---|---|");
    for (const item of payload.runtime.summary.scenario_breakdown) {
      lines.push(
        `| ${item.scenario} | ${item.passed} | ${item.prompt_equal} | ${item.tool_call_equal} | ${item.output_equal} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Asset Summary");
  lines.push("");
  if (payload.assets.skipped) {
    lines.push(`- skipped: ${payload.assets.detail}`);
  } else {
    lines.push(`- missing_in_node: ${payload.assets.summary.missing_in_node_count}`);
    lines.push(`- extra_in_node: ${payload.assets.summary.extra_in_node_count}`);
    lines.push(
      `- structured_semantic_diff: ${payload.assets.summary.structured_semantic_diff_count}`,
    );
    lines.push(
      `- unstructured_content_diff: ${payload.assets.summary.unstructured_content_diff_count}`,
    );
    lines.push(
      `- unstructured_strict_violations: ${payload.assets.summary.unstructured_strict_violation_count}`,
    );
    const categories = payload.assets.summary.unstructured_by_category;
    if (categories && Object.keys(categories).length > 0) {
      lines.push("");
      lines.push("| Category | Count |");
      lines.push("|---|---:|");
      for (const key of Object.keys(categories).sort((left, right) => left.localeCompare(right))) {
        lines.push(`| ${key} | ${asNumber(categories[key])} |`);
      }
    }
    if (payload.assets.summary.sample_structured_diffs.length > 0) {
      lines.push("");
      lines.push("Structured diff samples:");
      for (const relPath of payload.assets.summary.sample_structured_diffs) {
        lines.push(`- ${relPath}`);
      }
    }
    if (payload.assets.summary.sample_unstructured_strict_violations.length > 0) {
      lines.push("");
      lines.push("Strict violation samples:");
      for (const relPath of payload.assets.summary.sample_unstructured_strict_violations) {
        lines.push(`- ${relPath}`);
      }
    }
  }
  lines.push("");

  lines.push("## Reports");
  lines.push("");
  lines.push(`- Runtime report: ${payload.runtime.latest_json ?? "(none)"}`);
  lines.push(`- Asset report: ${payload.assets.latest_json ?? "(none)"}`);
  lines.push(`- Suite JSON: ${payload.artifacts.json_report}`);
  lines.push(`- Suite Markdown: ${payload.artifacts.markdown_report}`);

  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = ensureDir(options.outputDir);
  const runtimeOutputDir = join(outputDir, "runtime");
  const assetsOutputDir = join(outputDir, "assets");
  mkdirSync(runtimeOutputDir, { recursive: true });
  mkdirSync(assetsOutputDir, { recursive: true });

  const runtimeArgs = [join(THIS_DIR, "run_compare.py"), "--output-dir", runtimeOutputDir];
  if (options.skipIfBaselineMissing) {
    runtimeArgs.push("--skip-if-baseline-missing");
  }
  if (options.pythonBin) {
    runtimeArgs.push("--python-bin", options.pythonBin);
  }
  if (options.promptScenarios) {
    runtimeArgs.push("--prompt-scenarios", options.promptScenarios);
  }
  if (options.longScenario) {
    runtimeArgs.push("--long-scenario", options.longScenario);
  }
  if (options.maxCompactionDelta) {
    runtimeArgs.push("--max-compaction-delta", options.maxCompactionDelta);
  }
  if (options.maxFinalMessageDelta) {
    runtimeArgs.push("--max-final-message-delta", options.maxFinalMessageDelta);
  }

  const assetArgs = [join(THIS_DIR, "compare_assets.mjs"), "--output-dir", assetsOutputDir];
  if (options.skipIfBaselineMissing) {
    assetArgs.push("--skip-if-baseline-missing");
  }
  if (options.baselineRoot) {
    assetArgs.push("--baseline-root", options.baselineRoot);
  }
  if (options.nodeRoot) {
    assetArgs.push("--node-root", options.nodeRoot);
  }
  if (options.subdir) {
    assetArgs.push("--subdir", options.subdir);
  }
  if (options.strictExtra) {
    assetArgs.push("--strict-extra");
  }
  if (options.strictUnstructured) {
    assetArgs.push("--strict-unstructured");
  }
  if (options.strictUnstructuredPrefixes) {
    assetArgs.push("--strict-unstructured-prefixes", options.strictUnstructuredPrefixes);
  }

  const runtimeMeta = runCommand("python3", runtimeArgs);
  const assetsMeta = runCommand(process.execPath, assetArgs);

  const runtimeSkipped = Boolean(runtimeMeta.skipped);
  const runtimePayload = loadRuntimePayload(runtimeMeta);
  const runtimeSummary = buildRuntimeSummary(runtimePayload);
  const runtimePassed = runtimeSkipped
    ? true
    : Boolean(runtimePayload?.overall?.passed ?? runtimeMeta.overall_passed);
  const runtimeDetail = runtimeSkipped
    ? String(runtimeMeta.reason ?? "skipped")
    : buildRuntimeDetail(runtimePassed, runtimeSummary);

  const assetsSkipped = Boolean(assetsMeta.skipped);
  const assetPayload = loadAssetPayload(assetsMeta);
  const assetSummary = buildAssetSummary(assetPayload);
  const assetsPassed = assetsSkipped
    ? true
    : Boolean(assetPayload?.summary?.passed ?? assetsMeta.overall_passed);
  const assetsDetail = assetsSkipped
    ? String(assetsMeta.reason ?? "skipped")
    : buildAssetDetail(assetsPassed, assetSummary);

  const overallPassed = runtimePassed && assetsPassed;

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const suiteJsonPath = join(outputDir, `parity-suite-${timestamp}.json`);
  const suiteMdPath = join(outputDir, `parity-suite-${timestamp}.md`);
  const latestJsonPath = join(outputDir, "latest-suite.json");
  const latestMdPath = join(outputDir, "latest-suite.md");

  const payload = {
    generated_at: new Date().toISOString(),
    config: {
      output_dir: outputDir,
      skip_if_baseline_missing: options.skipIfBaselineMissing,
      strict_extra: options.strictExtra,
      strict_unstructured: options.strictUnstructured,
      strict_unstructured_prefixes: options.strictUnstructuredPrefixes,
      failures_only: options.failuresOnly,
    },
    runtime: {
      skipped: runtimeSkipped,
      passed: runtimePassed,
      detail: runtimeDetail,
      summary: runtimeSummary,
      latest_json: runtimeMeta.latest_json ?? null,
      latest_md: runtimeMeta.latest_md ?? null,
    },
    assets: {
      skipped: assetsSkipped,
      passed: assetsPassed,
      detail: assetsDetail,
      summary: assetSummary,
      latest_json: assetsMeta.latest_json ?? null,
      latest_md: assetsMeta.latest_md ?? null,
    },
    overall_passed: overallPassed,
    artifacts: {
      json_report: suiteJsonPath,
      markdown_report: suiteMdPath,
      latest_json: latestJsonPath,
      latest_md: latestMdPath,
    },
  };
  payload.failure_highlights = collectFailureHighlights(payload);

  const jsonText = JSON.stringify(payload, null, 2);
  const mdText = buildMarkdownReport(payload);
  writeFileSync(suiteJsonPath, jsonText, "utf-8");
  writeFileSync(suiteMdPath, mdText, "utf-8");
  writeFileSync(latestJsonPath, jsonText, "utf-8");
  writeFileSync(latestMdPath, mdText, "utf-8");

  process.stdout.write(
    `${JSON.stringify({
      json_report: suiteJsonPath,
      markdown_report: suiteMdPath,
      latest_json: latestJsonPath,
      latest_md: latestMdPath,
      overall_passed: overallPassed,
      runtime: {
        skipped: runtimeSkipped,
        overall_passed: runtimePassed,
      },
      assets: {
        skipped: assetsSkipped,
        overall_passed: assetsPassed,
      },
      failure_highlights: payload.failure_highlights,
    })}\n`,
  );

  if (options.check && !overallPassed) {
    throw new Error(
      `Parity suite gate failed: runtime_passed=${runtimePassed}, assets_passed=${assetsPassed}`,
    );
  }
}

main();
