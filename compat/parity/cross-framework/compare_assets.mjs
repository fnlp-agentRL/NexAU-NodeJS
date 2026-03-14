#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const THIS_DIR = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = resolve(THIS_DIR, "../../..");
const DEFAULT_BASELINE_ROOT = "/Users/yuning/Frontiers/NexAU-latest";
const DEFAULT_SUBDIR = "examples";
const STRUCTURED_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

function parseArgs(argv) {
  const options = {
    baselineRoot: DEFAULT_BASELINE_ROOT,
    nodeRoot: REPO_ROOT,
    subdir: DEFAULT_SUBDIR,
    outputDir: "",
    check: false,
    strictExtra: false,
    strictUnstructured: false,
    strictUnstructuredPrefixes: [],
    skipIfBaselineMissing: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--baseline-root":
        options.baselineRoot = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--node-root":
        options.nodeRoot = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--subdir":
        options.subdir = argv[i + 1] ?? DEFAULT_SUBDIR;
        i += 1;
        break;
      case "--output-dir":
        options.outputDir = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--check":
        options.check = true;
        break;
      case "--strict-extra":
        options.strictExtra = true;
        break;
      case "--strict-unstructured":
        options.strictUnstructured = true;
        break;
      case "--strict-unstructured-prefixes": {
        const raw = argv[i + 1] ?? "";
        i += 1;
        options.strictUnstructuredPrefixes = raw
          .split(",")
          .map((item) => item.trim().replaceAll("\\", "/"))
          .filter((item) => item.length > 0)
          .map((item) => item.replace(/^\/+/, "").replace(/\/+$/, ""));
        break;
      }
      case "--skip-if-baseline-missing":
        options.skipIfBaselineMissing = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function ensureOutputDir(outputDir) {
  if (outputDir) {
    const resolved = resolve(outputDir);
    mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  const generated = resolve(tmpdir(), `nexau-asset-parity-${Date.now()}`);
  mkdirSync(generated, { recursive: true });
  return generated;
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function collectFiles(rootPath) {
  const out = new Map();
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current)) {
      if (entry === ".DS_Store") {
        continue;
      }
      const fullPath = join(current, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const relPath = relative(rootPath, fullPath).replaceAll("\\", "/");
      const content = readFileSync(fullPath);
      out.set(relPath, {
        absolutePath: fullPath,
        ext: extname(fullPath).toLowerCase(),
        hash: sha256Hex(content),
        content,
      });
    }
  }
  return out;
}

function normalizeValue(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeValue(value[key]);
    }
    return result;
  }
  return String(value);
}

function parseStructured(ext, content) {
  const text = content.toString("utf-8");
  if (ext === ".json") {
    return JSON.parse(text);
  }
  if (ext === ".yaml" || ext === ".yml") {
    return parseYaml(text);
  }
  throw new Error(`Unsupported structured extension: ${ext}`);
}

function categorizeUnstructuredPath(relPath) {
  const normalized = relPath.replaceAll("\\", "/");
  const ext = extname(normalized).toLowerCase();
  const isDocLike = [".md", ".mdx", ".txt", ".rst"].includes(ext);
  if ((normalized.includes("/skills/") || normalized.includes("/docs/")) && isDocLike) {
    return "skills_docs";
  }
  if (normalized.includes("/frontend/")) {
    return "frontend_source";
  }
  if (isDocLike) {
    return "markdown_or_text";
  }
  return "other";
}

function matchesPrefix(relPath, prefixes) {
  if (prefixes.length === 0) {
    return false;
  }
  const normalized = relPath.replaceAll("\\", "/");
  return prefixes.some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix}/`) ||
      normalized.includes(`/${prefix}/`),
  );
}

function buildMarkdownReport(payload) {
  const summary = payload.summary;
  const lines = [];
  lines.push("# Asset Parity Report");
  lines.push("");
  lines.push(`- Generated at: ${payload.generated_at}`);
  lines.push(`- Baseline root: ${payload.config.baseline_root}`);
  lines.push(`- Node root: ${payload.config.node_root}`);
  lines.push(`- Compared subdir: ${payload.config.subdir}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Item | Count |");
  lines.push("|---|---:|");
  lines.push(`| Baseline files | ${summary.baseline_file_count} |`);
  lines.push(`| Node files | ${summary.node_file_count} |`);
  lines.push(`| Missing in Node | ${summary.missing_in_node_count} |`);
  lines.push(`| Extra in Node | ${summary.extra_in_node_count} |`);
  lines.push(`| Structured semantic diffs | ${summary.structured_semantic_diff_count} |`);
  lines.push(`| Unstructured content diffs | ${summary.unstructured_content_diff_count} |`);
  lines.push(`| Unstructured strict violations | ${summary.unstructured_strict_violation_count} |`);
  lines.push(`| Gate passed | ${summary.passed} |`);
  lines.push("");

  if (payload.missing_in_node.length > 0) {
    lines.push("## Missing in Node");
    lines.push("");
    for (const rel of payload.missing_in_node) {
      lines.push(`- ${rel}`);
    }
    lines.push("");
  }

  if (payload.structured_semantic_diff.length > 0) {
    lines.push("## Structured Semantic Diffs");
    lines.push("");
    for (const rel of payload.structured_semantic_diff) {
      lines.push(`- ${rel}`);
    }
    lines.push("");
  }

  if (payload.extra_in_node.length > 0) {
    lines.push("## Extra in Node");
    lines.push("");
    for (const rel of payload.extra_in_node) {
      lines.push(`- ${rel}`);
    }
    lines.push("");
  }

  if (
    payload.unstructured_by_category &&
    Object.keys(payload.unstructured_by_category).length > 0
  ) {
    lines.push("## Unstructured Diff Categories");
    lines.push("");
    for (const key of Object.keys(payload.unstructured_by_category).sort((left, right) =>
      left.localeCompare(right),
    )) {
      lines.push(`- ${key}: ${payload.unstructured_by_category[key]}`);
    }
    lines.push("");
  }

  if (payload.unstructured_strict_violations.length > 0) {
    lines.push("## Unstructured Strict Violations");
    lines.push("");
    for (const rel of payload.unstructured_strict_violations) {
      lines.push(`- ${rel}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const baselineRoot = resolve(options.baselineRoot, options.subdir);
  const nodeRoot = resolve(options.nodeRoot, options.subdir);

  if (!existsSync(resolve(options.baselineRoot))) {
    if (options.skipIfBaselineMissing) {
      process.stdout.write(
        `${JSON.stringify({ skipped: true, reason: "baseline root not found", baseline_root: options.baselineRoot })}\n`,
      );
      return;
    }
    throw new Error(`Baseline root not found: ${options.baselineRoot}`);
  }
  if (!existsSync(baselineRoot)) {
    throw new Error(`Baseline subdir not found: ${baselineRoot}`);
  }
  if (!existsSync(nodeRoot)) {
    throw new Error(`Node subdir not found: ${nodeRoot}`);
  }

  const baselineFiles = collectFiles(baselineRoot);
  const nodeFiles = collectFiles(nodeRoot);

  const missingInNode = [];
  const extraInNode = [];
  const structuredSemanticDiff = [];
  const unstructuredContentDiff = [];
  const unstructuredByCategory = {};

  for (const relPath of baselineFiles.keys()) {
    if (!nodeFiles.has(relPath)) {
      missingInNode.push(relPath);
    }
  }
  for (const relPath of nodeFiles.keys()) {
    if (!baselineFiles.has(relPath)) {
      extraInNode.push(relPath);
    }
  }

  for (const [relPath, baselineMeta] of baselineFiles.entries()) {
    const nodeMeta = nodeFiles.get(relPath);
    if (!nodeMeta) {
      continue;
    }
    if (baselineMeta.hash === nodeMeta.hash) {
      continue;
    }
    const ext = baselineMeta.ext;
    if (STRUCTURED_EXTENSIONS.has(ext)) {
      const baselineParsed = normalizeValue(parseStructured(ext, baselineMeta.content));
      const nodeParsed = normalizeValue(parseStructured(ext, nodeMeta.content));
      if (JSON.stringify(baselineParsed) !== JSON.stringify(nodeParsed)) {
        structuredSemanticDiff.push(relPath);
      }
      continue;
    }
    unstructuredContentDiff.push(relPath);
    const category = categorizeUnstructuredPath(relPath);
    unstructuredByCategory[category] = (unstructuredByCategory[category] ?? 0) + 1;
  }

  missingInNode.sort((left, right) => left.localeCompare(right));
  extraInNode.sort((left, right) => left.localeCompare(right));
  structuredSemanticDiff.sort((left, right) => left.localeCompare(right));
  unstructuredContentDiff.sort((left, right) => left.localeCompare(right));

  const unstructuredStrictViolations = options.strictUnstructured
    ? [...unstructuredContentDiff]
    : unstructuredContentDiff.filter((relPath) =>
        matchesPrefix(relPath, options.strictUnstructuredPrefixes),
      );

  const passed =
    missingInNode.length === 0 &&
    structuredSemanticDiff.length === 0 &&
    (!options.strictExtra || extraInNode.length === 0) &&
    unstructuredStrictViolations.length === 0;
  const outputDir = ensureOutputDir(options.outputDir);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const reportJsonPath = join(outputDir, `asset-parity-${timestamp}.json`);
  const reportMdPath = join(outputDir, `asset-parity-${timestamp}.md`);
  const latestJsonPath = join(outputDir, "latest.json");
  const latestMdPath = join(outputDir, "latest.md");

  const payload = {
    generated_at: new Date().toISOString(),
    config: {
      baseline_root: resolve(options.baselineRoot),
      node_root: resolve(options.nodeRoot),
      subdir: options.subdir,
      strict_extra: options.strictExtra,
      strict_unstructured: options.strictUnstructured,
      strict_unstructured_prefixes: options.strictUnstructuredPrefixes,
      output_dir: outputDir,
    },
    summary: {
      baseline_file_count: baselineFiles.size,
      node_file_count: nodeFiles.size,
      missing_in_node_count: missingInNode.length,
      extra_in_node_count: extraInNode.length,
      structured_semantic_diff_count: structuredSemanticDiff.length,
      unstructured_content_diff_count: unstructuredContentDiff.length,
      unstructured_strict_violation_count: unstructuredStrictViolations.length,
      passed,
    },
    missing_in_node: missingInNode,
    extra_in_node: extraInNode,
    structured_semantic_diff: structuredSemanticDiff,
    unstructured_content_diff: unstructuredContentDiff,
    unstructured_by_category: unstructuredByCategory,
    unstructured_strict_violations: unstructuredStrictViolations,
  };

  const reportJson = JSON.stringify(payload, null, 2);
  const reportMd = buildMarkdownReport(payload);
  writeFileSync(reportJsonPath, reportJson, "utf-8");
  writeFileSync(reportMdPath, reportMd, "utf-8");
  writeFileSync(latestJsonPath, reportJson, "utf-8");
  writeFileSync(latestMdPath, reportMd, "utf-8");

  process.stdout.write(
    `${JSON.stringify(
      {
        json_report: reportJsonPath,
        markdown_report: reportMdPath,
        latest_json: latestJsonPath,
        latest_md: latestMdPath,
        overall_passed: passed,
      },
      null,
      0,
    )}\n`,
  );

  if (options.check && !passed) {
    throw new Error(
      `Asset parity gate failed: missing_in_node=${missingInNode.length}, structured_semantic_diff=${structuredSemanticDiff.length}, extra_in_node=${extraInNode.length}, unstructured_strict_violations=${unstructuredStrictViolations.length}`,
    );
  }
}

main();
