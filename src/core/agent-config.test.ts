import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError } from "./config-error.js";
import { AgentConfig } from "./agent-config.js";

const TEST_ENV = {
  LLM_MODEL: "nex-agi/nex-n1.1",
  LLM_BASE_URL: "https://example.com/v1",
  LLM_API_KEY: "test-key",
};

function createTempConfigFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nexau-agent-config-"));
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return filePath;
}

describe("AgentConfig.fromYaml", () => {
  it("loads config, applies defaults, resolves jinja path and sub-agents", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-agent-config-nested-"));
    const promptPath = join(dir, "systemprompt.md");
    const subPath = join(dir, "subagent.yaml");
    const mainPath = join(dir, "main.yaml");

    writeFileSync(promptPath, "# Prompt");
    writeFileSync(
      subPath,
      [
        "type: agent",
        "name: child_agent",
        "llm_config:",
        "  model: child-model",
        "  base_url: https://child.example/v1",
        "  api_key: child-key",
      ].join("\n"),
    );
    writeFileSync(
      mainPath,
      [
        "type: agent",
        "system_prompt: ./systemprompt.md",
        "system_prompt_type: jinja",
        "tool_call_mode: OpenAI",
        "stop_tools: [complete_task]",
        "sub_agents:",
        "  - name: nested",
        "    config_path: ./subagent.yaml",
        "llm_config:",
        "  api_type: openai_chat_completion",
      ].join("\n"),
    );

    const config = AgentConfig.fromYaml(mainPath, {
      env: TEST_ENV,
    });

    expect(config.name).toBe("configured_agent");
    expect(config.system_prompt).toBe(resolve(promptPath));
    expect(config.tool_call_mode).toBe("openai");
    expect([...config.stop_tools]).toEqual(["complete_task"]);
    expect(Object.keys(config.sub_agents)).toEqual(["child_agent"]);
    expect(config.llm_config.model).toBe(TEST_ENV.LLM_MODEL);
    expect(config.max_context_tokens).toBe(128000);
    expect(config.max_iterations).toBe(100);
  });

  it("throws for invalid tool_call_mode", () => {
    const configPath = createTempConfigFile(
      "invalid_tool_mode.yaml",
      [
        "type: agent",
        "tool_call_mode: invalid",
        "llm_config:",
        "  api_type: openai_chat_completion",
      ].join("\n"),
    );

    expect(() => AgentConfig.fromYaml(configPath, { env: TEST_ENV })).toThrowError(ConfigError);
    expect(() => AgentConfig.fromYaml(configPath, { env: TEST_ENV })).toThrow(
      "tool_call_mode must be one of 'xml', 'openai', or 'anthropic'",
    );
  });

  it("includes field path in validation errors", () => {
    const configPath = createTempConfigFile(
      "invalid_iterations.yaml",
      [
        "type: agent",
        "max_iterations: 0",
        "llm_config:",
        "  api_type: openai_chat_completion",
      ].join("\n"),
    );

    expect(() => AgentConfig.fromYaml(configPath, { env: TEST_ENV })).toThrowError(ConfigError);
    expect(() => AgentConfig.fromYaml(configPath, { env: TEST_ENV })).toThrow("max_iterations");
  });

  it("detects recursive sub-agent references", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-agent-config-recursive-"));
    const configPath = join(dir, "self.yaml");
    writeFileSync(
      configPath,
      [
        "type: agent",
        "name: root",
        "sub_agents:",
        "  - name: self",
        "    config_path: ./self.yaml",
        "llm_config:",
        "  api_type: openai_chat_completion",
      ].join("\n"),
    );

    expect(() => AgentConfig.fromYaml(configPath, { env: TEST_ENV })).toThrow(
      "Detected recursive sub-agent reference",
    );
  });

  it("matches phase0 fixture compatibility fields", () => {
    const fixtureDir = resolve(process.cwd(), "compat/parity/fixtures");
    const fixtures = readdirSync(fixtureDir).filter((file) => file.endsWith(".fixture.json"));

    for (const fixtureFile of fixtures) {
      const fixturePath = join(fixtureDir, fixtureFile);
      const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
        meta: { baseline_repo: string; source_yaml: string };
        input: { env: NodeJS.ProcessEnv };
        output: {
          finalized_summary: {
            name: string;
            tool_call_mode: string;
            max_context_tokens: number;
            max_iterations: number;
            stop_tools: string[];
            resolved_system_prompt: string;
            system_prompt_type: string;
            sub_agents: string[];
            has_middlewares: boolean;
            llm_config: {
              model: string;
              base_url: string;
              api_type: string;
            };
          };
        };
      };

      const sourcePath = join(fixture.meta.baseline_repo, fixture.meta.source_yaml);
      if (!existsSync(sourcePath)) {
        continue;
      }

      const config = AgentConfig.fromYaml(sourcePath, {
        env: fixture.input.env,
      });

      const expected = fixture.output.finalized_summary;
      expect(config.name).toBe(expected.name);
      expect(config.tool_call_mode).toBe(expected.tool_call_mode);
      expect(config.max_context_tokens).toBe(expected.max_context_tokens);
      expect(config.max_iterations).toBe(expected.max_iterations);
      expect([...config.stop_tools].sort()).toEqual([...expected.stop_tools].sort());
      expect(config.system_prompt_type).toBe(expected.system_prompt_type);
      expect(config.system_prompt).toEqual(expected.resolved_system_prompt);
      expect(Object.keys(config.sub_agents).sort()).toEqual([...expected.sub_agents].sort());
      expect(Boolean(config.middlewares?.length)).toBe(expected.has_middlewares);
      expect(config.llm_config.model).toBe(expected.llm_config.model);
      expect(config.llm_config.base_url).toBe(expected.llm_config.base_url);
      expect(config.llm_config.api_type).toBe(expected.llm_config.api_type);
    }
  });

  it("injects LoadSkill when skill folders or as_skill tools are configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-agent-config-skill-"));
    const skillDir = join(dir, "skills", "demo");
    const skillPath = join(skillDir, "SKILL.md");
    const toolPath = join(dir, "save_memory.tool.yaml");
    const configPath = join(dir, "agent.yaml");

    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      toolPath,
      [
        "type: tool",
        "name: save_memory",
        "description: save fact",
        "skill_description: save fact skill",
        "input_schema:",
        "  type: object",
        "  properties:",
        "    fact:",
        "      type: string",
        "  required:",
        "    - fact",
        "  additionalProperties: false",
      ].join("\n"),
    );
    writeFileSync(
      skillPath,
      [
        "---",
        "name: demo-skill",
        "description: demo skill description",
        "---",
        "",
        "This is detail text.",
      ].join("\n"),
      { encoding: "utf-8" },
    );
    writeFileSync(
      configPath,
      [
        "type: agent",
        "name: skill_agent",
        "skills:",
        "  - ./skills/demo",
        "tools:",
        "  - name: save_memory",
        "    yaml_path: ./save_memory.tool.yaml",
        "    binding: nexau.archs.tool.builtin.session_tools:save_memory",
        "    as_skill: true",
        "llm_config:",
        "  api_type: openai_chat_completion",
      ].join("\n"),
    );

    const config = AgentConfig.fromYaml(configPath, { env: TEST_ENV });
    expect(config.tools.some((tool) => tool.name === "LoadSkill")).toBe(true);
    const loadSkill = config.tools.find((tool) => tool.name === "LoadSkill");
    expect(loadSkill?.description).toContain("demo-skill");
    expect(loadSkill?.description).toContain("save_memory");
  });

  it("returns detailed guidance for tool-based skills via LoadSkill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-agent-config-tool-skill-detail-"));
    const toolPath = join(dir, "save_memory.tool.yaml");
    const configPath = join(dir, "agent.yaml");

    writeFileSync(
      toolPath,
      [
        "type: tool",
        "name: save_memory",
        "description: Save memory fact.",
        "skill_description: Store one durable user/project fact for later rounds.",
        "input_schema:",
        "  type: object",
        "  properties:",
        "    fact:",
        "      type: string",
        "      description: Memory sentence.",
        "  required:",
        "    - fact",
        "  additionalProperties: false",
      ].join("\n"),
    );
    writeFileSync(
      configPath,
      [
        "type: agent",
        "name: skill_tool_agent",
        "tool_call_mode: openai",
        "tools:",
        "  - name: save_memory",
        "    yaml_path: ./save_memory.tool.yaml",
        "    binding: nexau.archs.tool.builtin.session_tools:save_memory",
        "    as_skill: true",
        "llm_config:",
        "  api_type: openai_chat_completion",
      ].join("\n"),
    );

    const config = AgentConfig.fromYaml(configPath, { env: TEST_ENV });
    const loadSkill = config.tools.find((tool) => tool.name === "LoadSkill");
    expect(loadSkill).toBeTruthy();

    const result = await loadSkill!.execute({ skill_name: "save_memory" });
    expect(typeof result.result).toBe("string");
    expect(String(result.result)).toContain("<SkillName>save_memory</SkillName>");
    expect(String(result.result)).toContain("## Detailed Description");
    expect(String(result.result)).toContain("Save memory fact.");
  });

  it("preserves configured skill folder expression in LoadSkill description", () => {
    const root = mkdtempSync(join(tmpdir(), "nexau-agent-config-skill-path-"));
    const configDir = join(root, "configs");
    const skillDir = join(root, "skills", "demo");
    const skillPath = join(skillDir, "SKILL.md");
    const configPath = join(configDir, "agent.yaml");

    mkdirSync(configDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      skillPath,
      ["---", "name: demo-skill", "description: demo skill description", "---"].join("\n"),
      { encoding: "utf-8" },
    );
    writeFileSync(
      configPath,
      [
        "type: agent",
        "name: skill_agent_path",
        "skills:",
        "  - ../skills/demo",
        "llm_config:",
        "  api_type: openai_chat_completion",
      ].join("\n"),
    );

    const config = AgentConfig.fromYaml(configPath, { env: TEST_ENV });
    const loadSkill = config.tools.find((tool) => tool.name === "LoadSkill");
    expect(loadSkill?.description).toContain(`Skill Folder: ${configDir}/../skills/demo`);
  });

  it("throws when skill folder does not contain SKILL.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-agent-config-skill-missing-"));
    const configPath = join(dir, "agent.yaml");

    writeFileSync(
      configPath,
      [
        "type: agent",
        "skills:",
        "  - ./skills/missing",
        "llm_config:",
        "  api_type: openai_chat_completion",
      ].join("\n"),
    );

    expect(() => AgentConfig.fromYaml(configPath, { env: TEST_ENV })).toThrow("SKILL.md not found");
  });

  it("throws when as_skill tool does not define skill_description", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexau-agent-config-skill-desc-"));
    const toolPath = join(dir, "tool.yaml");
    const configPath = join(dir, "agent.yaml");

    writeFileSync(
      toolPath,
      [
        "type: tool",
        "name: t1",
        "description: plain description",
        "input_schema:",
        "  type: object",
        "  properties: {}",
      ].join("\n"),
    );
    writeFileSync(
      configPath,
      [
        "type: agent",
        "tools:",
        "  - name: t1",
        "    yaml_path: ./tool.yaml",
        "    as_skill: true",
        "llm_config:",
        "  api_type: openai_chat_completion",
      ].join("\n"),
    );

    expect(() => AgentConfig.fromYaml(configPath, { env: TEST_ENV })).toThrow(
      "is marked as a skill but has no skill_description",
    );
  });
});
