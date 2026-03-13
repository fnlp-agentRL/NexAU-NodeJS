import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentConfig } from "../../core/agent-config.js";
import { Agent } from "../../core/agent.js";
import { RuntimeService } from "../../transport/runtime-service.js";
import { runChatCommand } from "./chat.js";

function createConfig(dir: string): string {
  const path = join(dir, "agent.yaml");
  writeFileSync(
    path,
    [
      "type: agent",
      "name: chat_test_agent",
      "llm_config:",
      "  model: t",
      "  base_url: https://example.com/v1",
      "  api_key: t",
    ].join("\n"),
  );
  return path;
}

describe("runChatCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports single-shot mode with stream events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-chat-cmd-"));
    const configPath = createConfig(dir);
    const config = AgentConfig.fromYaml(configPath);

    let called = false;
    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete() {
          if (!called) {
            called = true;
            return { content: "hello from cli" };
          }
          return { content: "done" };
        },
      }),
    });

    const runtime = new RuntimeService(agent);

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((...args: unknown[]) => {
      const chunk = args[0];
      if (typeof chunk === "string") {
        writes.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        writes.push(chunk.toString());
      }
      return true;
    }) as typeof process.stdout.write);

    const exitCode = await runChatCommand({
      config: configPath,
      message: "hello",
      stream: true,
      runtime,
    });

    expect(exitCode).toBe(0);
    expect(writes.join("\n")).toContain("[run.started]");
    expect(writes.join("\n")).toContain("hello from cli");
  });

  it("supports interactive mode and exits on /exit", async () => {
    const runtime = new RuntimeService({
      run: vi.fn(async (_input: string) => ({
        status: "completed",
        output: "interactive-output",
        iterations: 1,
        events: [],
        messages: [],
      })),
      config: { name: "x" },
    } as unknown as Agent);

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((...args: unknown[]) => {
      const chunk = args[0];
      if (typeof chunk === "string") {
        writes.push(chunk);
      }
      return true;
    }) as typeof process.stdout.write);

    const question = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("hello there")
      .mockResolvedValueOnce("/exit");
    const close = vi.fn();
    vi.spyOn(readline, "createInterface").mockReturnValue({
      question,
      close,
    } as unknown as ReturnType<typeof readline.createInterface>);

    const code = await runChatCommand({
      config: "unused",
      runtime,
    });
    expect(code).toBe(0);
    expect(writes.join("")).toContain("interactive-output");
    expect(close).toHaveBeenCalled();
  });

  it("builds runtime from config when runtime is not provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-chat-config-"));
    const configPath = createConfig(dir);
    const fakeDeps = {
      createLLMClient: () => ({
        async complete() {
          return { content: "from-config-runtime" };
        },
      }),
    };

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((...args: unknown[]) => {
      const chunk = args[0];
      if (typeof chunk === "string") {
        writes.push(chunk);
      }
      return true;
    }) as typeof process.stdout.write);

    const code = await runChatCommand({
      config: configPath,
      message: "hello",
      deps: fakeDeps,
    });
    expect(code).toBe(0);
    expect(writes.join("")).toContain("from-config-runtime");
  });
});
