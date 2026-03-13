import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Minimatch } from "minimatch";

function asString(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === undefined || value === null) {
    return "";
  }
  throw new Error(`Parameter '${field}' must be a string-compatible value`);
}

function addLineNumbers(content: string, startLine = 1): string {
  if (content.length === 0) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return "";
  }

  const maxLine = startLine + lines.length - 1;
  const width = String(maxLine).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, " ")}| ${line}`)
    .join("\n");
}

function resolvePath(input: string, cwd?: string): string {
  if (isAbsolute(input)) {
    return input;
  }
  return resolve(cwd ?? process.cwd(), input);
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (entry.isFile()) {
        files.push(nextPath);
      }
    }
  }

  return files;
}

export async function readFileTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = asString(params.file_path, "file_path");
  const offset = params.offset === undefined ? 0 : Number(params.offset);
  const limit = params.limit === undefined ? undefined : Number(params.limit);

  const resolvedPath = resolvePath(filePath);
  const content = readFileSync(resolvedPath, "utf-8");
  const lines = content.split("\n");

  const start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const end =
    limit !== undefined && Number.isFinite(limit) && limit >= 0 ? start + limit : lines.length;
  const selected = lines.slice(start, end);

  return {
    file_path: resolvedPath,
    content: selected.join("\n"),
    total_lines: lines.length,
    returned_lines: selected.length,
    truncated: end < lines.length,
    next_offset: end < lines.length ? end : null,
  };
}

export async function readManyFilesTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const paths = Array.isArray(params.paths) ? params.paths : [];
  const results: Array<Record<string, unknown>> = [];

  for (const item of paths) {
    const filePath = asString(item, "paths[]");
    const resolvedPath = resolvePath(filePath);
    const content = readFileSync(resolvedPath, "utf-8");
    results.push({
      file_path: resolvedPath,
      content,
    });
  }

  return {
    files: results,
    count: results.length,
  };
}

export async function writeFileTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = asString(params.file_path, "file_path");
  const content = asString(params.content, "content");
  const resolvedPath = resolvePath(filePath);

  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, content, "utf-8");

  return {
    file_path: resolvedPath,
    written: true,
    bytes_written: Buffer.byteLength(content),
  };
}

export async function replaceTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = asString(params.file_path, "file_path");
  const oldString = asString(params.old_string, "old_string");
  const newString = asString(params.new_string, "new_string");
  const expectedReplacements =
    params.expected_replacements === undefined ? undefined : Number(params.expected_replacements);

  const resolvedPath = resolvePath(filePath);
  const source = readFileSync(resolvedPath, "utf-8");
  const occurrences = oldString === "" ? 0 : source.split(oldString).length - 1;

  if (occurrences === 0) {
    throw new Error("No matches found for old_string");
  }

  if (expectedReplacements !== undefined && occurrences !== expectedReplacements) {
    throw new Error(
      `Expected ${expectedReplacements} replacements but found ${occurrences} occurrences`,
    );
  }

  if (expectedReplacements === undefined && occurrences !== 1) {
    throw new Error(`Expected a single replacement but found ${occurrences} occurrences`);
  }

  const updated = source.split(oldString).join(newString);
  writeFileSync(resolvedPath, updated, "utf-8");

  return {
    file_path: resolvedPath,
    replacements: occurrences,
  };
}

export async function listDirectoryTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dirPath = asString(params.dir_path, "dir_path");
  const ignorePatterns = Array.isArray(params.ignore)
    ? params.ignore.map((item) => asString(item, "ignore[]"))
    : [];
  const showHidden = params.show_hidden === undefined ? true : Boolean(params.show_hidden);

  const resolvedDir = resolvePath(dirPath);
  const matchers = ignorePatterns.map((pattern) => new Minimatch(pattern, { dot: true }));

  const entries = readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => {
      if (!showHidden && entry.name.startsWith(".")) {
        return false;
      }
      return !matchers.some((matcher) => matcher.match(entry.name));
    })
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    dir_path: resolvedDir,
    entries,
  };
}

export async function listDirectoryCompatTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await listDirectoryTool(params);
  const resolvedDir = asString(result.dir_path, "dir_path");
  const entries = Array.isArray(result.entries)
    ? (result.entries as Array<{ name: string; type: string }>)
    : [];

  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const lines = sorted.map((entry) =>
    entry.type === "directory" ? `[DIR] ${entry.name}` : entry.name,
  );
  const content = `Directory listing for ${resolvedDir}:\n${lines.join("\n")}`;
  return {
    content,
  };
}

export async function globTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const pattern = asString(params.pattern, "pattern");
  const dirPath = params.dir_path ? asString(params.dir_path, "dir_path") : process.cwd();
  const caseSensitive =
    params.case_sensitive === undefined ? false : Boolean(params.case_sensitive);
  const resolvedDir = resolvePath(dirPath);

  const matcher = new Minimatch(pattern, {
    dot: true,
    nocase: !caseSensitive,
  });

  const matched = walkFiles(resolvedDir)
    .filter((filePath) => matcher.match(filePath.slice(resolvedDir.length + 1)))
    .map((filePath) => ({
      file_path: filePath,
      mtime_ms: statSync(filePath).mtimeMs,
    }))
    .sort((a, b) => b.mtime_ms - a.mtime_ms)
    .map((item) => item.file_path);

  return {
    pattern,
    matches: matched,
  };
}

export async function searchFileContentTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const pattern = asString(params.pattern, "pattern");
  const include = params.include ? asString(params.include, "include") : undefined;
  const dirPath = params.dir_path ? asString(params.dir_path, "dir_path") : process.cwd();

  const regex = new RegExp(pattern);
  const includeMatcher = include ? new Minimatch(include, { dot: true }) : null;
  const resolvedDir = resolvePath(dirPath);

  const matches: Array<Record<string, unknown>> = [];
  const maxMatches = 20000;

  for (const filePath of walkFiles(resolvedDir)) {
    const relativePath = filePath.slice(resolvedDir.length + 1);
    if (includeMatcher && !includeMatcher.match(relativePath)) {
      continue;
    }

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!regex.test(line)) {
        continue;
      }

      matches.push({
        file_path: filePath,
        line_number: index + 1,
        line,
      });

      if (matches.length >= maxMatches) {
        return {
          pattern,
          matches,
          total_matches: matches.length,
          truncated: true,
        };
      }
    }
  }

  return {
    pattern,
    matches,
    total_matches: matches.length,
    truncated: false,
  };
}

export async function readFileCompatTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await readFileTool(params);
  const content = asString(result.content, "content");
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  const normalized = lines.join("\n");
  const offset =
    typeof params.offset === "number"
      ? params.offset
      : typeof params.offset === "string"
        ? Number(params.offset)
        : 0;
  const startLine = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) + 1 : 1;
  return {
    content: addLineNumbers(normalized, startLine),
  };
}
