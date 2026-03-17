import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PromptHandler } from "./prompt-handler.js";

describe("PromptHandler", () => {
  it("renders string and file/jinja prompts with context", () => {
    const handler = new PromptHandler();
    const dir = mkdtempSync(join(tmpdir(), "nexau-prompt-handler-"));
    const promptPath = join(dir, "prompt.md");
    writeFileSync(promptPath, "Hello {{agent_name}} at {{date}}.");

    expect(handler.validatePromptType("string")).toBe(true);
    expect(handler.validatePromptType("file")).toBe(true);
    expect(handler.validatePromptType("jinja")).toBe(true);
    expect(handler.validatePromptType("unknown")).toBe(false);

    expect(handler.processPrompt("A={{value}}", "string", { value: 3 })).toBe("A=3");
    expect(handler.processPrompt("", "string", { value: 3 })).toBe("");
    expect(handler.processPrompt("Raw text", "string")).toBe("Raw text");
    expect(
      handler.processPrompt(promptPath, "file", { agent_name: "agent", date: "2026-03-18" }),
    ).toBe("Hello agent at 2026-03-18.");
    expect(
      handler.processPrompt(promptPath, "jinja", { agent_name: "agent", date: "2026-03-18" }),
    ).toBe("Hello agent at 2026-03-18.");
  });

  it("creates dynamic prompts and rejects invalid prompt types", () => {
    const handler = new PromptHandler();
    const rendered = handler.createDynamicPrompt(
      "Agent={{agent_name}} Date={{date}}",
      { name: "demo", system_prompt_type: "string" },
      { date: "2026-03-18" },
      "string",
    );
    expect(rendered).toContain("Agent=demo");
    expect(rendered).toContain("Date=2026-03-18");

    const renderedWithDefaults = handler.createDynamicPrompt(
      "Agent={{agent_name}} Type={{system_prompt_type}}",
      {} as unknown as { name: string; system_prompt_type: "string" | "file" | "jinja" },
      undefined,
      "string",
    );
    expect(renderedWithDefaults).toContain("Agent=Unknown Agent");
    expect(renderedWithDefaults).toContain("Type=string");

    expect(() => handler.processPrompt("x", "invalid" as never, {})).toThrowError(
      "Invalid prompt type: invalid",
    );
    expect(() =>
      handler.createDynamicPrompt(
        "x",
        { name: "demo", system_prompt_type: "string" },
        {},
        "invalid" as never,
      ),
    ).toThrowError("Invalid template type: invalid");
  });
});
