import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
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

function resolvePatchPath(inputPath: string, rootDir: string): string {
  if (isAbsolute(inputPath)) {
    throw new Error(`Patch path must be relative: ${inputPath}`);
  }
  const resolvedPath = resolve(rootDir, inputPath);
  const rel = relative(rootDir, resolvedPath);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) {
    return resolvedPath;
  }
  throw new Error(`Patch path escapes root directory: ${inputPath}`);
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

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".tiff",
  ".tif",
  ".svg",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv", ".m4v"]);
const MAX_VISUAL_FILE_SIZE_BYTES = 10 * 1024 * 1024;

function isVisualFilePath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension);
}

function splitTextLines(content: string): { lines: string[]; trailingNewline: boolean } {
  if (content.length === 0) {
    return { lines: [], trailingNewline: false };
  }
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (trailingNewline && lines.at(-1) === "") {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function joinTextLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }
  const merged = lines.join("\n");
  return trailingNewline ? `${merged}\n` : merged;
}

function findLineSequence(haystack: string[], needle: string[], start: number): number | undefined {
  if (needle.length === 0) {
    return start;
  }

  for (let index = start; index <= haystack.length - needle.length; index += 1) {
    const matched = needle.every((item, offset) => haystack[index + offset] === item);
    if (matched) {
      return index;
    }
  }

  for (let index = start; index <= haystack.length - needle.length; index += 1) {
    const matched = needle.every(
      (item, offset) => haystack[index + offset]?.trimEnd() === item.trimEnd(),
    );
    if (matched) {
      return index;
    }
  }

  return undefined;
}

interface ParsedUpdateChunk {
  oldLines: string[];
  newLines: string[];
}

interface ParsedUpdateHunk {
  kind: "update";
  path: string;
  movePath?: string;
  chunks: ParsedUpdateChunk[];
}

interface ParsedAddHunk {
  kind: "add";
  path: string;
  content: string;
}

interface ParsedDeleteHunk {
  kind: "delete";
  path: string;
}

type ParsedPatchHunk = ParsedUpdateHunk | ParsedAddHunk | ParsedDeleteHunk;

function parseUpdateChunks(lines: string[]): ParsedUpdateChunk[] {
  const chunks: ParsedUpdateChunk[] = [];
  let index = 0;

  while (index < lines.length) {
    const marker = lines[index] ?? "";
    if (marker === "@@" || marker.startsWith("@@ ")) {
      index += 1;
    }

    const oldLines: string[] = [];
    const newLines: string[] = [];
    let consumedAny = false;

    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line === "*** End of File") {
        index += 1;
        break;
      }
      if (line === "@@" || line.startsWith("@@ ")) {
        break;
      }

      if (line.startsWith("+")) {
        newLines.push(line.slice(1));
        consumedAny = true;
        index += 1;
        continue;
      }
      if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
        consumedAny = true;
        index += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        const payload = line.slice(1);
        oldLines.push(payload);
        newLines.push(payload);
        consumedAny = true;
        index += 1;
        continue;
      }
      if (line === "") {
        oldLines.push("");
        newLines.push("");
        consumedAny = true;
        index += 1;
        continue;
      }

      if (!consumedAny) {
        throw new Error(`Invalid update hunk line: ${line}`);
      }
      break;
    }

    if (!consumedAny) {
      throw new Error("Update hunk chunk does not contain any change lines");
    }

    chunks.push({ oldLines, newLines });
  }

  if (chunks.length === 0) {
    throw new Error("Update hunk has no chunks");
  }

  return chunks;
}

function parseApplyPatchInput(input: string): ParsedPatchHunk[] {
  const normalized = input.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (lines.length < 2 || lines[0]?.trim() !== "*** Begin Patch") {
    throw new Error("Patch must start with '*** Begin Patch'");
  }
  if (lines.at(-1)?.trim() !== "*** End Patch") {
    throw new Error("Patch must end with '*** End Patch'");
  }

  const hunks: ParsedPatchHunk[] = [];
  let index = 1;
  const end = lines.length - 1;

  while (index < end) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      index += 1;
      const addLines: string[] = [];

      while (index < end) {
        const nextLine = lines[index] ?? "";
        if (nextLine.startsWith("*** ")) {
          break;
        }
        if (!nextLine.startsWith("+")) {
          throw new Error(`Add file line must start with '+': ${nextLine}`);
        }
        addLines.push(nextLine.slice(1));
        index += 1;
      }

      hunks.push({
        kind: "add",
        path,
        content: addLines.join("\n"),
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      hunks.push({
        kind: "delete",
        path,
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      index += 1;
      let movePath: string | undefined;
      if ((lines[index] ?? "").startsWith("*** Move to: ")) {
        movePath = (lines[index] ?? "").slice("*** Move to: ".length).trim();
        index += 1;
      }

      const chunkLines: string[] = [];
      while (index < end) {
        const nextLine = lines[index] ?? "";
        if (nextLine.startsWith("*** ")) {
          break;
        }
        chunkLines.push(nextLine);
        index += 1;
      }

      hunks.push({
        kind: "update",
        path,
        movePath,
        chunks: parseUpdateChunks(chunkLines),
      });
      continue;
    }

    throw new Error(`Unsupported patch line: ${line}`);
  }

  return hunks;
}

function applyUpdateHunk(original: string, hunk: ParsedUpdateHunk): string {
  const { lines: originalLines, trailingNewline } = splitTextLines(original);
  let lines = [...originalLines];
  let searchStart = 0;

  for (const chunk of hunk.chunks) {
    const position = findLineSequence(lines, chunk.oldLines, searchStart);
    if (position === undefined) {
      throw new Error(`Failed to locate patch chunk for file: ${hunk.path}`);
    }
    lines = [
      ...lines.slice(0, position),
      ...chunk.newLines,
      ...lines.slice(position + chunk.oldLines.length),
    ];
    searchStart = position + chunk.newLines.length;
  }

  return joinTextLines(lines, trailingNewline);
}

function inferImageMimeType(extension: string): string {
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  return `image/${extension.slice(1)}`;
}

export async function readFileTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = asString(params.file_path, "file_path");
  const offset = params.offset === undefined ? 0 : Number(params.offset);
  const limit = params.limit === undefined ? undefined : Number(params.limit);

  const resolvedPath = resolvePath(filePath);
  if (isVisualFilePath(resolvedPath)) {
    throw new Error("Use the read_visual_file tool instead of read_file for image and video files");
  }
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

export async function applyPatchTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = asString(params.input, "input");
  const rootDir = params.dir_path
    ? resolvePath(asString(params.dir_path, "dir_path"))
    : process.cwd();

  const hunks = parseApplyPatchInput(input);
  const updatedFiles: string[] = [];

  for (const hunk of hunks) {
    if (hunk.kind === "add") {
      const targetPath = resolvePatchPath(hunk.path, rootDir);
      if (existsSync(targetPath)) {
        throw new Error(`Cannot add file that already exists: ${hunk.path}`);
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, hunk.content, "utf-8");
      updatedFiles.push(`A ${hunk.path}`);
      continue;
    }

    if (hunk.kind === "delete") {
      const targetPath = resolvePatchPath(hunk.path, rootDir);
      if (!existsSync(targetPath)) {
        throw new Error(`Cannot delete missing file: ${hunk.path}`);
      }
      unlinkSync(targetPath);
      updatedFiles.push(`D ${hunk.path}`);
      continue;
    }

    const sourcePath = resolvePatchPath(hunk.path, rootDir);
    if (!existsSync(sourcePath)) {
      throw new Error(`Cannot update missing file: ${hunk.path}`);
    }
    const original = readFileSync(sourcePath, "utf-8");
    const patched = applyUpdateHunk(original, hunk);
    writeFileSync(sourcePath, patched, "utf-8");

    if (hunk.movePath) {
      const movedPath = resolvePatchPath(hunk.movePath, rootDir);
      if (existsSync(movedPath) && movedPath !== sourcePath) {
        throw new Error(`Cannot move file onto existing target: ${hunk.movePath}`);
      }
      mkdirSync(dirname(movedPath), { recursive: true });
      if (movedPath !== sourcePath) {
        renameSync(sourcePath, movedPath);
      }
      updatedFiles.push(`R ${hunk.path} -> ${hunk.movePath}`);
      continue;
    }

    updatedFiles.push(`M ${hunk.path}`);
  }

  const content =
    updatedFiles.length === 0
      ? "No files were modified."
      : `Success. Updated the following files:\n${updatedFiles.join("\n")}`;

  return {
    success: true,
    content,
    returnDisplay: content,
    updated_files: updatedFiles,
  };
}

export async function readVisualFileTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = asString(params.file_path, "file_path");
  const resolvedPath = resolvePath(filePath);
  const extension = extname(resolvedPath).toLowerCase();
  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    const imageDetailInput =
      params.image_detail === undefined ? "auto" : asString(params.image_detail, "image_detail");
    if (!["low", "high", "auto"].includes(imageDetailInput)) {
      throw new Error("image_detail must be one of low/high/auto");
    }

    const content = readFileSync(resolvedPath);
    if (content.byteLength > MAX_VISUAL_FILE_SIZE_BYTES) {
      throw new Error(
        `Image file exceeds size limit (${MAX_VISUAL_FILE_SIZE_BYTES} bytes): ${resolvedPath}`,
      );
    }
    const mimeType = inferImageMimeType(extension);

    return {
      file_path: resolvedPath,
      media_type: "image",
      content: [
        {
          type: "image",
          image_url: `data:${mimeType};base64,${content.toString("base64")}`,
          detail: imageDetailInput,
        },
      ],
      returnDisplay: `Read image file: ${resolvedPath}`,
    };
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    const message =
      "Video parsing is not enabled in this Node rewrite yet; return metadata only for compatibility.";
    return {
      file_path: resolvedPath,
      media_type: "video",
      content: message,
      returnDisplay: message,
      frame_support: false,
    };
  }

  throw new Error(`Unsupported visual file type '${extension}'`);
}
