import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../core/agent.js";
import { AgentConfig } from "../core/agent-config.js";
import { RuntimeService } from "../transport/runtime-service.js";

interface FixtureFile {
  meta: {
    baseline_repo: string;
    source_yaml: string;
  };
  input: {
    env: NodeJS.ProcessEnv;
  };
}

function readFixture(path: string): FixtureFile {
  return JSON.parse(readFileSync(path, "utf-8")) as FixtureFile;
}

function resolveFixtureSource(fixture: FixtureFile): string {
  const localSourcePath = resolve(process.cwd(), fixture.meta.source_yaml);
  if (existsSync(localSourcePath)) {
    return localSourcePath;
  }
  return resolve(fixture.meta.baseline_repo, fixture.meta.source_yaml);
}

describe("Phase7 regression for core examples", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "code_agent.fixture.json",
    "deep_research_agent.fixture.json",
    "leader_agent.fixture.json",
  ])("loads and runs %s", async (fixtureFile) => {
    // Avoid real network in tracer flush calls during regression runs.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        async json() {
          return {};
        },
        async text() {
          return "";
        },
      })),
    );

    const fixturePath = resolve(process.cwd(), "compat/parity/fixtures", fixtureFile);
    const fixture = readFixture(fixturePath);
    const sourcePath = resolveFixtureSource(fixture);

    const config = AgentConfig.fromYaml(sourcePath, {
      env: fixture.input.env,
    });

    const agent = new Agent(config, {
      createLLMClient: () => ({
        async complete() {
          return {
            content: `phase7-ok:${config.name}`,
          };
        },
      }),
    });

    const runtime = new RuntimeService(agent);
    const result = await runtime.query({
      input: "phase7 regression",
      user_id: "phase7-user",
      session_id: "phase7-session",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe(`phase7-ok:${config.name}`);
    expect(result.events.some((event) => event.type === "run.started")).toBe(true);
    expect(result.events.some((event) => event.type === "run.completed")).toBe(true);
  });
});
