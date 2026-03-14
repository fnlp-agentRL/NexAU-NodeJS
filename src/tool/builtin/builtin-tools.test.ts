import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyPatchTool,
  globTool,
  listDirectoryCompatTool,
  listDirectoryTool,
  readFileCompatTool,
  readManyFilesTool,
  readFileTool,
  readVisualFileTool,
  replaceTool,
  searchFileContentTool,
  writeFileTool,
} from "./file-tools.js";
import { runShellCommandTool } from "./shell-tools.js";
import {
  askUserTool,
  completeTaskTool,
  saveMemoryCompatTool,
  saveMemoryTool,
  writeTodosTool,
} from "./session-tools.js";
import { webFetchTool, webSearchTool } from "./web-tools.js";

describe("builtin tools", () => {
  it("supports write/read/replace/search/list file flow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-builtin-file-"));
    const filePath = join(dir, "sample.txt");

    await writeFileTool({ file_path: filePath, content: "hello\nworld\nhello" });

    const readResult = await readFileTool({ file_path: filePath, offset: 1, limit: 1 });
    expect(readResult.content).toBe("world");

    const replaceResult = await replaceTool({
      file_path: filePath,
      instruction: "replace one",
      old_string: "world",
      new_string: "node",
    });
    expect(replaceResult.replacements).toBe(1);

    const searchResult = await searchFileContentTool({ pattern: "hello", dir_path: dir });
    expect(Array.isArray(searchResult.matches)).toBe(true);

    const listResult = await listDirectoryTool({ dir_path: dir });
    expect(listResult.entries).toEqual([{ name: "sample.txt", type: "file" }]);

    expect(readFileSync(filePath, "utf-8")).toContain("node");
  });

  it("supports glob and read_many_files, and validates replacement constraints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-builtin-glob-"));
    const aPath = join(dir, "a.ts");
    const bPath = join(dir, "b.txt");
    await writeFileTool({ file_path: aPath, content: "console.log('a')" });
    await writeFileTool({ file_path: bPath, content: "hello" });

    const globResult = await globTool({
      pattern: "**/*.ts",
      dir_path: dir,
      case_sensitive: false,
    });
    expect(globResult.matches).toEqual([aPath]);

    const manyResult = await readManyFilesTool({ paths: [aPath, bPath] });
    expect(manyResult.count).toBe(2);

    await expect(
      replaceTool({
        file_path: bPath,
        instruction: "replace missing",
        old_string: "not-found",
        new_string: "x",
      }),
    ).rejects.toThrow("No matches found");

    await writeFileTool({ file_path: bPath, content: "x x" });
    await expect(
      replaceTool({
        file_path: bPath,
        instruction: "replace mismatched count",
        old_string: "x",
        new_string: "y",
        expected_replacements: 1,
      }),
    ).rejects.toThrow("Expected 1 replacements");
  });

  it("runs shell command and captures output", async () => {
    const result = await runShellCommandTool({ command: "echo nexau-phase2" });
    expect(String(result.output)).toContain("nexau-phase2");
  });

  it("supports shell background mode and non-zero exit", async () => {
    const bgResult = await runShellCommandTool({
      command: "sleep 0.1",
      is_background: true,
    });
    expect(Array.isArray(bgResult.background_pids)).toBe(true);

    const failResult = await runShellCommandTool({ command: "exit 7" });
    expect(failResult.exit_code).toBe(7);
  });

  it("updates session state for todos and memory", async () => {
    const state: Record<string, unknown> = {};

    const todoResult = await writeTodosTool({
      agent_state: state,
      todos: [{ description: "task1", status: "in_progress" }],
    });
    expect(todoResult.count).toBe(1);

    const memoryResult = await saveMemoryTool({
      agent_state: state,
      fact: "User likes TypeScript",
    });
    expect(memoryResult.saved).toBe(true);

    const askResult = await askUserTool({
      questions: [{ header: "Choice", question: "Pick one?" }],
    });
    expect(askResult.action).toBe("ask_user");

    const completeResult = await completeTaskTool({ result: "done" });
    expect(completeResult.completed).toBe(true);
  });

  it("handles type coercion and validation errors on builtin params", async () => {
    const noStateTodoResult = await writeTodosTool({
      todos: [{ description: "task-x", status: "pending" }],
    });
    expect(noStateTodoResult.count).toBe(1);

    const numberFactResult = await saveMemoryTool({
      agent_state: {},
      fact: 123,
    });
    expect(numberFactResult.fact).toBe("123");

    const boolComplete = await completeTaskTool({ result: true });
    expect(boolComplete.result).toBe("true");

    await expect(
      runShellCommandTool({ command: { nested: "bad" } as unknown as string }),
    ).rejects.toThrow("command");
    await expect(saveMemoryTool({ fact: { nested: "bad" } as unknown as string })).rejects.toThrow(
      "fact",
    );
    await expect(webSearchTool({ query: { nested: "bad" } as unknown as string })).rejects.toThrow(
      "query",
    );
  });

  it("returns web search stub payload", async () => {
    const result = await webSearchTool({ query: "nexau", num_results: 5 });
    expect(result.query).toBe("nexau");
    expect(result.num_results).toBe(5);
    expect(result.provider).toBe("stub");

    const numericQueryResult = await webSearchTool({ query: 42, num_results: 2 });
    expect(numericQueryResult.query).toBe("42");
  });

  it("fetches web page content from local server", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>NexAU</title></head><body>Hello Web</body></html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server");
    }
    const result = await webFetchTool({ url: `http://127.0.0.1:${address.port}` });
    expect(result.status).toBe(200);
    expect(result.title).toBe("NexAU");
    expect(String(result.content)).toContain("Hello Web");

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("applies list_directory filtering rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-list-filter-"));
    await writeFileTool({ file_path: join(dir, ".hidden"), content: "x" });
    await writeFileTool({ file_path: join(dir, "keep.ts"), content: "x" });
    await writeFileTool({ file_path: join(dir, "drop.log"), content: "x" });

    const result = await listDirectoryTool({
      dir_path: dir,
      show_hidden: false,
      ignore: ["*.log"],
    });
    expect(result.entries).toEqual([{ name: "keep.ts", type: "file" }]);
  });

  it("returns python-compatible wrappers for file and memory tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-compat-wrapper-"));
    const filePath = join(dir, "note.txt");
    await writeFileTool({ file_path: filePath, content: "line1\nline2\nline3\n" });

    const listResult = await listDirectoryCompatTool({ dir_path: dir });
    expect(String(listResult.content)).toContain("Directory listing for");
    expect(String(listResult.content)).toContain("note.txt");
    expect(listResult.returnDisplay).toBeUndefined();

    const readResult = await readFileCompatTool({ file_path: filePath, offset: 1, limit: 1 });
    expect(readResult.content).toBe("2| line2");

    const memoryResult = await saveMemoryCompatTool({
      agent_state: {},
      fact: "Remember this",
    });
    expect(memoryResult.content).toBe(
      `{"success": true, "message": "Okay, I've remembered that: \\"Remember this\\""}`,
    );
    expect(memoryResult.returnDisplay).toBeUndefined();
  });

  it("supports apply_patch add/update/delete and move operations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-apply-patch-"));
    const sourcePath = join(dir, "sample.txt");
    await writeFileTool({ file_path: sourcePath, content: "hello\nworld\n" });

    const patch = [
      "*** Begin Patch",
      "*** Update File: sample.txt",
      "@@",
      " hello",
      "-world",
      "+node",
      "*** Add File: added.txt",
      "+new line",
      "*** End Patch",
    ].join("\n");
    const result = await applyPatchTool({ input: patch, dir_path: dir });

    expect(result.success).toBe(true);
    expect(String(result.content)).toContain("M sample.txt");
    expect(String(result.content)).toContain("A added.txt");
    expect(readFileSync(sourcePath, "utf-8")).toBe("hello\nnode\n");
    expect(readFileSync(join(dir, "added.txt"), "utf-8")).toBe("new line");

    const movePatch = [
      "*** Begin Patch",
      "*** Update File: sample.txt",
      "*** Move to: renamed.txt",
      "@@",
      " hello",
      " node",
      "*** End Patch",
    ].join("\n");
    await applyPatchTool({ input: movePatch, dir_path: dir });
    expect(readFileSync(join(dir, "renamed.txt"), "utf-8")).toBe("hello\nnode\n");
  });

  it("reads image files via read_visual_file tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-read-visual-"));
    const imagePath = join(dir, "pixel.png");
    await writeFileTool({ file_path: imagePath, content: "not-a-real-png" });

    const result = await readVisualFileTool({
      file_path: imagePath,
      image_detail: "high",
    });

    expect(result.media_type).toBe("image");
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Array<Record<string, unknown>>;
    const imageUrl = blocks[0]?.image_url;
    expect(typeof imageUrl).toBe("string");
    expect(imageUrl).toContain("data:image/png;base64,");
    expect(blocks[0]?.detail).toBe("high");
  });

  it("covers visual video branch and read_file visual guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-visual-video-"));
    const videoPath = join(dir, "clip.mp4");
    await writeFileTool({ file_path: videoPath, content: "fake-video" });

    const visualResult = await readVisualFileTool({ file_path: videoPath });
    expect(visualResult.media_type).toBe("video");
    expect(visualResult.frame_support).toBe(false);

    await expect(readFileTool({ file_path: videoPath })).rejects.toThrow("read_visual_file");
  });

  it("supports apply_patch delete operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-apply-patch-delete-"));
    const targetPath = join(dir, "delete-me.txt");
    await writeFileTool({ file_path: targetPath, content: "bye" });

    const patch = ["*** Begin Patch", "*** Delete File: delete-me.txt", "*** End Patch"].join("\n");
    const result = await applyPatchTool({ input: patch, dir_path: dir });
    expect(String(result.content)).toContain("D delete-me.txt");
    await expect(readFileTool({ file_path: targetPath })).rejects.toThrow();
  });
});
