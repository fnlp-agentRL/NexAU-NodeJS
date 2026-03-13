import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentConfig } from "../core/agent-config.js";
import { Agent } from "../core/agent.js";
import { SqliteSessionManager } from "../session/sqlite-session-manager.js";
import { RuntimeService } from "./runtime-service.js";

function createConfig(
  dir: string,
  name = "runtime_session_test",
  options: {
    systemPrompt?: string;
  } = {},
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  const lines = [
    "type: agent",
    `name: ${name}`,
    "llm_config:",
    "  model: t",
    "  base_url: https://example.com/v1",
    "  api_key: t",
  ];
  if (options.systemPrompt) {
    lines.splice(2, 0, "system_prompt: |", `  ${options.systemPrompt}`);
  }
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("RuntimeService sessions", () => {
  it("restores session history across service instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-runtime-session-"));
    const configPath = createConfig(dir);
    const config = AgentConfig.fromYaml(configPath);
    const dbPath = join(dir, "sessions.db");

    const calls: number[] = [];
    const createAgent = (): Agent =>
      new Agent(config, {
        createLLMClient: () => ({
          async complete(input) {
            calls.push(input.messages.length);
            return {
              content: `messages=${input.messages.length}`,
            };
          },
        }),
      });

    const manager1 = new SqliteSessionManager(dbPath);
    const runtime1 = new RuntimeService(createAgent(), manager1);
    const first = await runtime1.query({
      input: "hello",
      user_id: "u1",
      session_id: "s1",
    });
    expect(first.output).toContain("messages=");
    await manager1.close();

    const manager2 = new SqliteSessionManager(dbPath);
    const runtime2 = new RuntimeService(createAgent(), manager2);
    const second = await runtime2.query({
      input: "again",
      user_id: "u1",
      session_id: "s1",
    });
    expect(second.output).toContain("messages=");

    // First call roughly has only latest user input, second call should include restored history.
    expect(calls.length).toBe(2);
    expect(calls[0]).toBeTypeOf("number");
    expect(calls[1]).toBeTypeOf("number");
    if (calls[0] === undefined || calls[1] === undefined) {
      throw new Error("Expected both LLM calls to be recorded");
    }
    expect(calls[1]).toBeGreaterThan(calls[0]);

    await manager2.close();
  });

  it("isolates different session ids under same user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-runtime-isolation-"));
    const configPath = createConfig(dir);
    const config = AgentConfig.fromYaml(configPath);

    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete(input) {
          return {
            content: `count=${input.messages.length}`,
          };
        },
      }),
    });

    const manager = new SqliteSessionManager(join(dir, "sessions.db"));
    const runtime = new RuntimeService(agent, manager);

    const a1 = await runtime.query({ input: "hello", user_id: "u", session_id: "a" });
    const b1 = await runtime.query({ input: "hello", user_id: "u", session_id: "b" });
    const a2 = await runtime.query({ input: "again", user_id: "u", session_id: "a" });

    const countA1 = Number(a1.output.split("=")[1]);
    const countB1 = Number(b1.output.split("=")[1]);
    const countA2 = Number(a2.output.split("=")[1]);

    expect(countA1).toBe(countB1);
    expect(countA2).toBeGreaterThan(countA1);

    await manager.close();
  });

  it("isolates same user/session across different agents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-runtime-agent-isolation-"));
    const dbPath = join(dir, "sessions.db");

    const configA = AgentConfig.fromYaml(createConfig(dir, "agent_a"));
    const configB = AgentConfig.fromYaml(createConfig(dir, "agent_b"));

    const createAgent = (config: AgentConfig): Agent =>
      new Agent(config, {
        createLLMClient: () => ({
          async complete(input) {
            return {
              content: `count=${input.messages.length}`,
            };
          },
        }),
      });

    const manager = new SqliteSessionManager(dbPath);
    const runtimeA = new RuntimeService(createAgent(configA), manager);
    const runtimeB = new RuntimeService(createAgent(configB), manager);

    const a1 = await runtimeA.query({ input: "hello", user_id: "u", session_id: "s" });
    const b1 = await runtimeB.query({ input: "hello", user_id: "u", session_id: "s" });
    const a2 = await runtimeA.query({ input: "again", user_id: "u", session_id: "s" });
    const b2 = await runtimeB.query({ input: "again", user_id: "u", session_id: "s" });

    const countA1 = Number(a1.output.split("=")[1]);
    const countB1 = Number(b1.output.split("=")[1]);
    const countA2 = Number(a2.output.split("=")[1]);
    const countB2 = Number(b2.output.split("=")[1]);

    expect(countA1).toBe(countB1);
    expect(countA2).toBeGreaterThan(countA1);
    expect(countB2).toBeGreaterThan(countB1);

    await manager.close();
  });

  it("isolates same user/session across same-name agents with different configs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-runtime-same-name-isolation-"));
    const dirA = join(dir, "a");
    const dirB = join(dir, "b");
    const dbPath = join(dir, "sessions.db");
    const sameName = "agent_same_name";

    const configA = AgentConfig.fromYaml(
      createConfig(dirA, sameName, { systemPrompt: "A prompt" }),
    );
    const configB = AgentConfig.fromYaml(
      createConfig(dirB, sameName, { systemPrompt: "B prompt" }),
    );

    const createAgent = (config: AgentConfig): Agent =>
      new Agent(config, {
        createLLMClient: () => ({
          async complete(input) {
            return {
              content: `count=${input.messages.length}`,
            };
          },
        }),
      });

    const manager = new SqliteSessionManager(dbPath);
    const runtimeA = new RuntimeService(createAgent(configA), manager);
    const runtimeB = new RuntimeService(createAgent(configB), manager);

    const a1 = await runtimeA.query({ input: "hello", user_id: "u", session_id: "s" });
    const b1 = await runtimeB.query({ input: "hello", user_id: "u", session_id: "s" });
    const a2 = await runtimeA.query({ input: "again", user_id: "u", session_id: "s" });
    const b2 = await runtimeB.query({ input: "again", user_id: "u", session_id: "s" });

    const countA1 = Number(a1.output.split("=")[1]);
    const countB1 = Number(b1.output.split("=")[1]);
    const countA2 = Number(a2.output.split("=")[1]);
    const countB2 = Number(b2.output.split("=")[1]);

    expect(countA1).toBe(countB1);
    expect(countA2).toBeGreaterThan(countA1);
    expect(countB2).toBeGreaterThan(countB1);

    await manager.close();
  });

  it("persists partial interrupted history and allows recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-runtime-interrupt-recover-"));
    const config = AgentConfig.fromYaml(createConfig(dir, "agent_interrupt"));
    const manager = new SqliteSessionManager(join(dir, "sessions.db"));

    let step = 0;
    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete() {
          if (step === 0) {
            step += 1;
            return {
              content: "first-iteration",
              tool_calls: [
                {
                  id: "missing-tool",
                  name: "unknown_tool",
                  arguments: {},
                },
              ],
            };
          }
          return {
            content: `recovered-${step}`,
          };
        },
      }),
    });

    const runtime = new RuntimeService(agent, manager);
    const controller = new AbortController();
    const interrupted = await runtime.query(
      {
        input: "interrupt me",
        user_id: "u",
        session_id: "s",
        signal: controller.signal,
      },
      (event) => {
        if (event.type === "tool.completed") {
          controller.abort();
        }
      },
    );

    expect(interrupted.status).toBe("failed");
    expect(interrupted.events.some((event) => event.type === "run.failed")).toBe(true);

    const recovered = await runtime.query({
      input: "continue",
      user_id: "u",
      session_id: "s",
    });

    expect(recovered.status).toBe("completed");
    expect(recovered.output.startsWith("recovered")).toBe(true);

    await manager.close();
  });
});
