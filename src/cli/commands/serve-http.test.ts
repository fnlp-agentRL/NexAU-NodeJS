import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentConfig } from "../../core/agent-config.js";
import { Agent } from "../../core/agent.js";
import { RuntimeService } from "../../transport/runtime-service.js";
import { runServeHttpCommand } from "./serve-http.js";

describe("runServeHttpCommand", () => {
  const servers: Array<import("node:http").Server> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (!server) {
        continue;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("starts and returns an http server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-serve-http-"));
    const configPath = join(dir, "agent.yaml");
    writeFileSync(
      configPath,
      [
        "type: agent",
        "name: serve_http_test",
        "llm_config:",
        "  model: t",
        "  base_url: https://example.com/v1",
        "  api_key: t",
      ].join("\n"),
    );

    const config = AgentConfig.fromYaml(configPath);
    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete() {
          return { content: "ok" };
        },
      }),
    });
    const runtime = new RuntimeService(agent);

    const server = await runServeHttpCommand({
      config: configPath,
      host: "127.0.0.1",
      port: 0,
      runtime,
    });
    servers.push(server);

    const address = server.address();
    expect(address).toBeTruthy();
  });

  it("builds runtime from config when runtime is not provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-serve-http-default-"));
    const configPath = join(dir, "agent.yaml");
    writeFileSync(
      configPath,
      [
        "type: agent",
        "name: serve_http_default",
        "llm_config:",
        "  model: t",
        "  base_url: https://example.com/v1",
        "  api_key: t",
      ].join("\n"),
    );

    const server = await runServeHttpCommand({
      config: configPath,
      host: "127.0.0.1",
      port: 0,
    });
    servers.push(server);
    expect(server.listening).toBe(true);
  });
});
