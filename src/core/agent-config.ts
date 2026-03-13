import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";

import { loadYamlWithVars } from "../compat/yaml-loader.js";
import { Tool } from "../tool/tool.js";
import { ConfigError } from "./config-error.js";
import { LLMConfig, type LLMConfigInput } from "./llm-config.js";
import { normalizeToolCallMode, type ToolCallMode } from "./tool-call-mode.js";

const SystemPromptTypeSchema = z.enum(["string", "file", "jinja"]);
const HookImportSchema = z
  .object({
    import: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const HookDefinitionSchema = z.union([z.string(), HookImportSchema]);

const ToolConfigEntrySchema = z
  .object({
    name: z.string(),
    yaml_path: z.string(),
    binding: z.string().optional(),
    lazy: z.boolean().default(false),
    as_skill: z.boolean().default(false),
    extra_kwargs: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const SubAgentConfigEntrySchema = z
  .object({
    name: z.string(),
    config_path: z.string(),
  })
  .strict();

const SystemPromptBlockSchema = z
  .object({
    content: z.string(),
    cache: z.boolean().default(true),
  })
  .strict();

const AgentConfigSchema = z
  .object({
    type: z.literal("agent").optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    system_prompt: z
      .union([z.string(), z.array(z.union([z.string(), SystemPromptBlockSchema]))])
      .optional(),
    system_prompt_type: SystemPromptTypeSchema.default("string"),
    system_prompt_suffix: z.string().optional(),
    tools: z.array(ToolConfigEntrySchema).default([]),
    sub_agents: z.array(SubAgentConfigEntrySchema).default([]),
    skills: z.array(z.string()).default([]),
    llm_config: z.record(z.string(), z.unknown()),
    stop_tools: z.array(z.string()).default([]),
    initial_state: z.record(z.string(), z.unknown()).optional(),
    initial_config: z.record(z.string(), z.unknown()).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    initial_context: z.record(z.string(), z.unknown()).optional(),
    mcp_servers: z.array(z.unknown()).default([]),
    after_model_hooks: z.array(HookDefinitionSchema).optional(),
    after_tool_hooks: z.array(HookDefinitionSchema).optional(),
    before_model_hooks: z.array(HookDefinitionSchema).optional(),
    before_tool_hooks: z.array(HookDefinitionSchema).optional(),
    middlewares: z.array(HookDefinitionSchema).optional(),
    token_counter: HookDefinitionSchema.optional(),
    global_storage: z.record(z.string(), z.unknown()).default({}),
    max_context_tokens: z.int().min(1).default(128000),
    max_running_subagents: z.int().min(0).default(5),
    max_iterations: z.int().min(1).default(100),
    tool_call_mode: z.string().default("openai"),
    retry_attempts: z.int().min(0).default(5),
    timeout: z.int().min(1).default(300),
    tracers: z.array(HookDefinitionSchema).default([]),
    sandbox_config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type AgentConfigParsed = z.infer<typeof AgentConfigSchema>;

export interface ToolConfigEntry {
  name: string;
  yaml_path: string;
  binding?: string;
  lazy: boolean;
  as_skill: boolean;
  extra_kwargs: Record<string, unknown>;
}

export interface SystemPromptBlock {
  content: string;
  cache: boolean;
}

interface FromYamlOptions {
  env?: NodeJS.ProcessEnv;
  _visitedPaths?: Set<string>;
}

interface SkillDefinition {
  name: string;
  description: string | null;
  detail: string | null;
  folder: string;
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length === 0 ? "root" : issue.path.map(String).join("->");
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}

function ensurePathExists(path: string, message: string): void {
  if (!existsSync(path)) {
    throw new ConfigError(message);
  }
}

function parseSkillMarkdown(skillPath: string, folderOverride?: string): SkillDefinition {
  const content = readFileSync(skillPath, "utf-8");
  if (!content.startsWith("---")) {
    throw new ConfigError(`Skill file must start with YAML frontmatter: ${skillPath}`);
  }

  const lines = content.split("\n");
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      endIndex = index;
      break;
    }
  }
  if (endIndex === -1) {
    throw new ConfigError(`Skill file is missing closing YAML frontmatter marker: ${skillPath}`);
  }

  const frontmatter = lines.slice(1, endIndex).join("\n");
  const detail = lines
    .slice(endIndex + 1)
    .join("\n")
    .trim();
  const parsedFrontmatter = z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
    })
    .parse(YAML.parse(frontmatter));

  return {
    name: parsedFrontmatter.name,
    description: parsedFrontmatter.description ?? null,
    detail: detail.length > 0 ? detail : null,
    folder: folderOverride ?? dirname(skillPath),
  };
}

function resolveSkillDefinitions(skillPaths: string[], basePath: string): SkillDefinition[] {
  const resolved: SkillDefinition[] = [];
  for (const skillPath of skillPaths) {
    const displayFolder = skillPath.startsWith("/") ? skillPath : `${basePath}/${skillPath}`;
    const folderPath = resolve(basePath, skillPath);
    const markdownPath = resolve(folderPath, "SKILL.md");
    ensurePathExists(markdownPath, `SKILL.md not found in skill folder: ${displayFolder}`);
    resolved.push(parseSkillMarkdown(markdownPath, displayFolder));
  }
  return resolved;
}

function generateSkillToolDescription(skills: SkillDefinition[], tools: Tool[]): string {
  let description = "<Skills>\n";
  const seen = new Set<string>();

  for (const skill of skills) {
    description += "<SkillBrief>\n";
    description += `Skill Name: ${skill.name}\n`;
    description += `Skill Folder: ${skill.folder}\n`;
    description += `Skill Brief Description: ${skill.description ?? ""}\n\n`;
    description += "</SkillBrief>\n";
    seen.add(skill.name);
  }

  for (const tool of tools) {
    if (!tool.asSkill || seen.has(tool.name)) {
      continue;
    }
    if (!tool.skillDescription) {
      throw new ConfigError(`Tool ${tool.name} is marked as a skill but has no skill_description`);
    }
    description += "<SkillBrief>\n";
    description += `Skill Name: ${tool.name}\n`;
    description += "Skill Folder: \n";
    description += `Skill Brief Description: ${tool.skillDescription}\n\n`;
    description += "</SkillBrief>\n";
    seen.add(tool.name);
  }

  description += "</Skills>\n";
  return description;
}

function buildLoadSkillTool(tools: Tool[], skills: SkillDefinition[]): Tool | null {
  if (tools.some((tool) => tool.name === "LoadSkill")) {
    return null;
  }

  const hasSkillTools = tools.some((tool) => tool.asSkill);
  if (!hasSkillTools && skills.length === 0) {
    return null;
  }

  const skillRegistry = new Map<string, SkillDefinition>();
  for (const skill of skills) {
    skillRegistry.set(skill.name, skill);
  }
  for (const tool of tools) {
    if (!tool.asSkill) {
      continue;
    }
    if (!tool.skillDescription) {
      throw new ConfigError(`Tool ${tool.name} is marked as a skill but has no skill_description`);
    }
    if (!skillRegistry.has(tool.name)) {
      skillRegistry.set(tool.name, {
        name: tool.name,
        description: tool.skillDescription,
        detail: null,
        folder: "",
      });
    }
  }

  const implementation = async (params: Record<string, unknown>): Promise<string> => {
    const skillName = typeof params.skill_name === "string" ? params.skill_name : "";
    const skill = skillRegistry.get(skillName);
    if (!skill) {
      throw new Error(`Skill ${skillName} not found`);
    }

    return (
      `Found the skill details of \`${skill.name}\`.\n` +
      "Note that the paths mentioned in skill description are relative to the skill folder.\n" +
      `<SkillDetails>\n` +
      `<SkillName>${skill.name}</SkillName>\n` +
      `<SkillFolder>${skill.folder}</SkillFolder>\n` +
      `<SkillDescription>${skill.description ?? ""}</SkillDescription>\n` +
      `<SkillDetail>${skill.detail ?? ""}</SkillDetail>\n` +
      `</SkillDetails>`
    );
  };

  return new Tool({
    name: "LoadSkill",
    description:
      "Load a skill from skill folders. If user task is related to a skill, you can use this tool to load the skill for detailed information about the skill." +
      generateSkillToolDescription(skills, tools),
    inputSchema: {
      type: "object",
      properties: {
        skill_name: {
          type: "string",
          description: "The name of the skill to load",
        },
      },
      required: ["skill_name"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    implementation,
  });
}

function resolveSystemPrompt(
  systemPrompt: AgentConfigParsed["system_prompt"],
  systemPromptType: AgentConfigParsed["system_prompt_type"],
  basePath: string,
): string | Array<string | SystemPromptBlock> | undefined {
  if (!systemPrompt || (systemPromptType !== "file" && systemPromptType !== "jinja")) {
    return systemPrompt;
  }

  if (Array.isArray(systemPrompt)) {
    return systemPrompt.map((item) => {
      const block = typeof item === "string" ? { content: item, cache: true } : item;
      const promptPath = resolve(basePath, block.content);
      ensurePathExists(promptPath, `System prompt file not found: ${promptPath}`);
      return {
        content: promptPath,
        cache: block.cache,
      };
    });
  }

  const resolved = resolve(basePath, systemPrompt);
  ensurePathExists(resolved, `System prompt file not found: ${resolved}`);
  return resolved;
}

function buildTools(toolConfigs: ToolConfigEntry[], basePath: string): Tool[] {
  const tools: Tool[] = [];

  for (const toolConfig of toolConfigs) {
    const yamlPath = resolve(basePath, toolConfig.yaml_path);
    const tool = Tool.fromYaml(yamlPath, toolConfig.binding ?? null, {
      asSkill: toolConfig.as_skill,
      extraKwargs: toolConfig.extra_kwargs,
      lazy: toolConfig.lazy,
      nameOverride: toolConfig.name,
    });
    tools.push(tool);
  }

  return tools;
}

export class AgentConfig {
  public readonly type?: "agent";
  public readonly name: string;
  public readonly description?: string;
  public readonly system_prompt?: string | Array<string | SystemPromptBlock>;
  public readonly system_prompt_type: "string" | "file" | "jinja";
  public readonly system_prompt_suffix?: string;
  public readonly tools: Tool[];
  public readonly tool_configs: ToolConfigEntry[];
  public readonly skills: string[];
  public readonly llm_config: LLMConfig;
  public readonly stop_tools: Set<string>;
  public readonly initial_state?: Record<string, unknown>;
  public readonly initial_config?: Record<string, unknown>;
  public readonly initial_context?: Record<string, unknown>;
  public readonly mcp_servers: unknown[];
  public readonly after_model_hooks?: Array<
    string | { import: string; params?: Record<string, unknown> }
  >;
  public readonly after_tool_hooks?: Array<
    string | { import: string; params?: Record<string, unknown> }
  >;
  public readonly before_model_hooks?: Array<
    string | { import: string; params?: Record<string, unknown> }
  >;
  public readonly before_tool_hooks?: Array<
    string | { import: string; params?: Record<string, unknown> }
  >;
  public readonly middlewares?: Array<
    string | { import: string; params?: Record<string, unknown> }
  >;
  public readonly token_counter?: string | { import: string; params?: Record<string, unknown> };
  public readonly global_storage: Record<string, unknown>;
  public readonly max_context_tokens: number;
  public readonly max_running_subagents: number;
  public readonly max_iterations: number;
  public readonly retry_attempts: number;
  public readonly timeout: number;
  public readonly tool_call_mode: ToolCallMode;
  public readonly tracers: Array<string | { import: string; params?: Record<string, unknown> }>;
  public readonly sandbox_config?: Record<string, unknown>;
  public readonly sub_agents: Record<string, AgentConfig>;
  public readonly resolved_tracer: { type: "single" | "composite"; count: number } | null;

  private constructor(input: {
    parsed: AgentConfigParsed;
    llmConfig: LLMConfig;
    resolvedSystemPrompt?: string | Array<string | SystemPromptBlock>;
    subAgents: Record<string, AgentConfig>;
    tools: Tool[];
    skillDefinitions: SkillDefinition[];
  }) {
    this.type = input.parsed.type;
    this.name = input.parsed.name ?? "configured_agent";
    this.description = input.parsed.description;
    this.system_prompt = input.resolvedSystemPrompt ?? input.parsed.system_prompt;
    this.system_prompt_type = input.parsed.system_prompt_type;
    this.system_prompt_suffix = input.parsed.system_prompt_suffix;
    this.tool_configs = input.parsed.tools;
    this.tools = input.tools;
    this.skills = input.parsed.skills;
    this.llm_config = input.llmConfig;
    this.stop_tools = new Set(input.parsed.stop_tools);
    this.initial_state = input.parsed.initial_state;
    this.initial_config = input.parsed.initial_config;
    this.initial_context = input.parsed.initial_context ?? input.parsed.context;
    this.mcp_servers = input.parsed.mcp_servers;
    this.after_model_hooks = input.parsed.after_model_hooks;
    this.after_tool_hooks = input.parsed.after_tool_hooks;
    this.before_model_hooks = input.parsed.before_model_hooks;
    this.before_tool_hooks = input.parsed.before_tool_hooks;
    this.middlewares = input.parsed.middlewares;
    this.token_counter = input.parsed.token_counter;
    this.global_storage = input.parsed.global_storage;
    this.max_context_tokens = input.parsed.max_context_tokens;
    this.max_running_subagents = input.parsed.max_running_subagents;
    this.max_iterations = input.parsed.max_iterations;
    this.retry_attempts = input.parsed.retry_attempts;
    this.timeout = input.parsed.timeout;
    this.tool_call_mode = normalizeToolCallMode(input.parsed.tool_call_mode);
    this.tracers = input.parsed.tracers;
    this.sandbox_config = input.parsed.sandbox_config;
    this.sub_agents = input.subAgents;

    const loadSkillTool = buildLoadSkillTool(this.tools, input.skillDefinitions);
    if (loadSkillTool) {
      this.tools.push(loadSkillTool);
    }

    if (this.tracers.length === 0) {
      this.resolved_tracer = null;
    } else if (this.tracers.length === 1) {
      this.resolved_tracer = { type: "single", count: 1 };
    } else {
      this.resolved_tracer = { type: "composite", count: this.tracers.length };
    }
  }

  public static fromYaml(path: string, options: FromYamlOptions = {}): AgentConfig {
    const configPath = resolve(path);
    ensurePathExists(configPath, `Configuration file not found: ${path}`);

    const visitedPaths = options._visitedPaths ?? new Set<string>();
    if (visitedPaths.has(configPath)) {
      throw new ConfigError(`Detected recursive sub-agent reference: ${configPath}`);
    }
    visitedPaths.add(configPath);

    const loaded = loadYamlWithVars(configPath, { env: options.env });
    if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
      throw new ConfigError(`Empty or invalid configuration file: ${path}`);
    }

    const parsedResult = AgentConfigSchema.safeParse(loaded);
    if (!parsedResult.success) {
      throw new ConfigError(
        `Invalid agent configuration: ${formatValidationError(parsedResult.error)}`,
      );
    }

    const parsed = parsedResult.data;
    const basePath = dirname(configPath);

    const subAgents: Record<string, AgentConfig> = {};
    for (const subAgentConfig of parsed.sub_agents) {
      const subConfigPath = resolve(basePath, subAgentConfig.config_path);
      const subAgent = AgentConfig.fromYaml(subConfigPath, {
        env: options.env,
        _visitedPaths: visitedPaths,
      });
      subAgents[subAgent.name] = subAgent;
    }

    const resolvedSystemPrompt = resolveSystemPrompt(
      parsed.system_prompt,
      parsed.system_prompt_type,
      basePath,
    );

    const llmConfig = new LLMConfig(parsed.llm_config as LLMConfigInput, {
      env: options.env,
    });

    const tools = buildTools(parsed.tools, basePath);
    const skillDefinitions = resolveSkillDefinitions(parsed.skills, basePath);

    visitedPaths.delete(configPath);

    return new AgentConfig({
      parsed,
      llmConfig,
      resolvedSystemPrompt,
      subAgents,
      tools,
      skillDefinitions,
    });
  }

  public toSerializable(): Record<string, unknown> {
    return {
      type: this.type,
      name: this.name,
      description: this.description,
      system_prompt: this.system_prompt,
      system_prompt_type: this.system_prompt_type,
      system_prompt_suffix: this.system_prompt_suffix,
      tools: this.tools.map((tool) => tool.getInfo()),
      tool_configs: this.tool_configs,
      skills: this.skills,
      llm_config: {
        model: this.llm_config.model,
        base_url: this.llm_config.base_url,
        api_key: this.llm_config.api_key,
        temperature: this.llm_config.temperature,
        max_tokens: this.llm_config.max_tokens,
        top_p: this.llm_config.top_p,
        frequency_penalty: this.llm_config.frequency_penalty,
        presence_penalty: this.llm_config.presence_penalty,
        timeout: this.llm_config.timeout,
        max_retries: this.llm_config.max_retries,
        debug: this.llm_config.debug,
        stream: this.llm_config.stream,
        additional_drop_params: this.llm_config.additional_drop_params,
        api_type: this.llm_config.api_type,
        cache_control_ttl: this.llm_config.cache_control_ttl,
        ...this.llm_config.extra_params,
      },
      stop_tools: [...this.stop_tools],
      initial_state: this.initial_state,
      initial_config: this.initial_config,
      initial_context: this.initial_context,
      mcp_servers: this.mcp_servers,
      middlewares: this.middlewares,
      tracers: this.tracers,
      max_context_tokens: this.max_context_tokens,
      max_running_subagents: this.max_running_subagents,
      max_iterations: this.max_iterations,
      retry_attempts: this.retry_attempts,
      timeout: this.timeout,
      tool_call_mode: this.tool_call_mode,
      sandbox_config: this.sandbox_config,
      sub_agents: Object.keys(this.sub_agents),
      resolved_tracer: this.resolved_tracer,
    };
  }
}
