import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError } from "../core/config-error.js";
import { resolveToolImplementation } from "./registry.js";
import { Tool } from "./tool.js";

describe("Tool", () => {
  it("loads from yaml and validates schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-tool-"));
    const yamlPath = join(dir, "echo.tool.yaml");

    writeFileSync(
      yamlPath,
      [
        "type: tool",
        "name: echo",
        "description: echo tool",
        "input_schema:",
        "  type: object",
        "  properties:",
        "    message:",
        "      type: string",
        "  required:",
        "    - message",
        "  additionalProperties: false",
      ].join("\n"),
    );

    const tool = Tool.fromYaml(yamlPath, async (params) => ({ message: params.message }));
    const result = await tool.execute({ message: "hello" });

    expect(result).toEqual({ message: "hello" });
  });

  it("wraps schema validation errors with stable shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-tool-validation-"));
    const yamlPath = join(dir, "sum.tool.yaml");

    writeFileSync(
      yamlPath,
      [
        "type: tool",
        "name: sum",
        "description: sum tool",
        "input_schema:",
        "  type: object",
        "  properties:",
        "    a:",
        "      type: number",
        "  required:",
        "    - a",
        "  additionalProperties: false",
      ].join("\n"),
    );

    const tool = Tool.fromYaml(yamlPath, async (params) => ({ result: params.a }));
    const result = await tool.execute({ a: "invalid" });

    expect(result.error).toBeTypeOf("string");
    expect(result.error_type).toBe("Error");
    expect(result.traceback).toBeTypeOf("string");
    expect(result.tool_name).toBe("sum");
  });

  it("rejects reserved extra_kwargs keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-tool-extra-"));
    const yamlPath = join(dir, "x.tool.yaml");

    writeFileSync(
      yamlPath,
      [
        "type: tool",
        "name: x",
        "description: x",
        "input_schema:",
        "  type: object",
        "  properties: {}",
      ].join("\n"),
    );

    expect(() => Tool.fromYaml(yamlPath, null, { extraKwargs: { agent_state: {} } })).toThrowError(
      ConfigError,
    );
  });

  it("executes builtin file tool via binding registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-tool-registry-"));
    const targetPath = join(dir, "hello.txt");
    const yamlPath = join(dir, "write.tool.yaml");

    writeFileSync(
      yamlPath,
      [
        "type: tool",
        "name: write_file",
        "description: write",
        "input_schema:",
        "  type: object",
        "  properties:",
        "    file_path:",
        "      type: string",
        "    content:",
        "      type: string",
        "  required:",
        "    - file_path",
        "    - content",
        "  additionalProperties: false",
      ].join("\n"),
    );

    const tool = Tool.fromYaml(yamlPath, "nexau.archs.tool.builtin.file_tools:write_file");
    const result = await tool.execute({ file_path: targetPath, content: "abc" });

    expect(result.written).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe("abc");
  });

  it("returns wrapped error when implementation is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-tool-missing-"));
    const yamlPath = join(dir, "missing.tool.yaml");
    writeFileSync(
      yamlPath,
      [
        "type: tool",
        "name: unknown_tool",
        "description: missing impl",
        "input_schema:",
        "  type: object",
        "  properties: {}",
      ].join("\n"),
    );

    const tool = Tool.fromYaml(yamlPath);
    const result = await tool.execute({});
    expect(result.error).toContain("has no implementation");
    expect(result.tool_name).toBe("unknown_tool");
  });

  it("rejects tool yaml when reserved framework params appear in input schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-tool-reserved-"));
    const yamlPath = join(dir, "bad.tool.yaml");
    writeFileSync(
      yamlPath,
      [
        "type: tool",
        "name: bad_tool",
        "description: bad tool",
        "input_schema:",
        "  type: object",
        "  properties:",
        "    agent_state:",
        "      type: string",
      ].join("\n"),
    );
    expect(() => Tool.fromYaml(yamlPath)).toThrowError(ConfigError);
  });

  it("converts tool definition to openai and anthropic shapes", () => {
    const tool = new Tool({
      name: "shape_tool",
      description: "shape",
      inputSchema: { type: "object", properties: {} },
      implementation: async () => ({ ok: true }),
    });

    expect(tool.toOpenAI()).toEqual({
      type: "function",
      function: {
        name: "shape_tool",
        description: "shape",
        parameters: { type: "object", properties: {} },
      },
    });
    expect(tool.toAnthropic()).toEqual({
      name: "shape_tool",
      description: "shape",
      input_schema: { type: "object", properties: {} },
    });
  });

  it("resolves implementation by binding and by tool name", () => {
    expect(
      resolveToolImplementation("nexau.archs.tool.builtin.file_tools:read_file", "ignored_name"),
    ).toBeTypeOf("function");
    expect(resolveToolImplementation(undefined, "write_todos")).toBeTypeOf("function");
    expect(resolveToolImplementation(undefined, "Bash")).toBeTypeOf("function");
    expect(resolveToolImplementation(undefined, "TodoWrite")).toBeTypeOf("function");
    expect(resolveToolImplementation(undefined, "Write")).toBeTypeOf("function");
    expect(resolveToolImplementation(undefined, "apply_patch")).toBeTypeOf("function");
    expect(resolveToolImplementation(undefined, "read_visual_file")).toBeTypeOf("function");
    expect(
      resolveToolImplementation(
        "nexau.archs.tool.builtin.file_tools:apply_patch",
        "ignored_name_2",
      ),
    ).toBeTypeOf("function");
    expect(resolveToolImplementation(undefined, "not_exists")).toBeUndefined();
  });
});
