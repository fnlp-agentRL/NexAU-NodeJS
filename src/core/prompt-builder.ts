import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Tool } from "../tool/tool.js";
import type { AgentConfig, SystemPromptBlock } from "./agent-config.js";
import { PromptHandler } from "./prompt-handler.js";

export interface SystemPromptPart {
  text: string;
  cache: boolean;
}

interface ToolParameter {
  name: string;
  description: string;
  type: string;
  required: boolean;
  default: unknown;
}

const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `You are an AI agent named '{{ agent_name }}' built on the NexAU framework.

{% if tools %}
You have access to the following tools:
{% for tool in tools %}
- {{ tool.name }}: {{ tool.description or 'No description' }}
{% endfor %}
{% else %}
You currently have no tools available.
{% endif %}

{% if sub_agents %}
You can delegate tasks to the following sub-agents:
{% for sub_agent in sub_agents %}
- {{ sub_agent.name }}: {{ sub_agent.description or 'Specialized agent for ' + sub_agent.name + '-related tasks' }}
{% endfor %}
{% else %}
You currently have no sub-agents available.
{% endif %}

Your goal is to help users accomplish their tasks efficiently by:
1. Understanding the user's request
2. Determining if you can handle it with your available tools
3. Delegating to appropriate sub-agents when their specialized capabilities are needed
4. Executing the necessary actions and providing clear, helpful responses`;

const TOOL_EXECUTION_INSTRUCTIONS = `
CRITICAL TOOL EXECUTION INSTRUCTIONS:
When you use tools or sub-agents, include the XML blocks in your response and I will execute them and provide the results.

CRITICAL CONSTRAINT: You MUST output only ONE type of tool call XML at a time. DO NOT mix different types of tool calls in a single response.

Valid tool call types (use only ONE per response):
1. Single tool or sub_agent: <tool_use>
2. Parallel tools or sub_agents or mixture of them: <use_parallel_tool_calls>

IMPORTANT: each response should only contain ONE type of tool call XML.
If you generate </tool_use>, </use_parallel_tool_calls>, you should stop your response immediately.

IMPORTANT: After outputting any tool call XML block, you MUST STOP and WAIT for the tool execution results before continuing your response. Do NOT continue generating text after tool calls until you receive the results.

For single tool execution:
<tool_use>
  <tool_name>tool_name</tool_name>
  <parameter>
    <param_name>value</param_name>
  </parameter>
</tool_use>

For single sub_agent delegation:
<tool_use>
  <tool_name>agent:{agent_name}</tool_name>
  <parameter>
    <message>task description</message>
  </parameter>
</tool_use>

For parallel execution of multiple tools or sub_agents or mixture of them, use:
<use_parallel_tool_calls>
<parallel_tool>
  <tool_name>tool1</tool_name>
  <parameter>...</parameter>
</parallel_tool>
<parallel_tool>
  <tool_name>agent:{agent_name}</tool_name>
  <parameter>
    <message>task description</message>
  </parameter>
</parallel_tool>
</use_parallel_tool_calls>

EXECUTION FLOW REMINDER:
1. Choose ONLY ONE type of tool call XML for your response
2. When you output XML tool/agent blocks, STOP your response immediately
3. Wait for the execution results to be provided to you
4. Only then continue with analysis of the results and next steps
5. Never generate additional content after XML blocks until results are returned`;

function toPythonType(jsonType: string): string {
  switch (jsonType) {
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "array":
      return "list";
    case "object":
      return "dict";
    default:
      return "str";
  }
}

function normalizeSystemPromptBlocks(
  value: string | Array<string | SystemPromptBlock> | undefined,
): Array<string | SystemPromptBlock> {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

export class PromptBuilder {
  private readonly promptHandler: PromptHandler;

  public constructor() {
    this.promptHandler = new PromptHandler();
  }

  public buildSystemPrompt(
    agentConfig: AgentConfig,
    tools: Tool[] | undefined,
    subAgents: Record<string, AgentConfig> | undefined,
    runtimeContext: Record<string, unknown> | undefined,
    includeToolInstructions: boolean,
  ): SystemPromptPart[] {
    const baseParts = this.getBaseSystemPrompt(agentConfig, runtimeContext ?? {});
    if (!includeToolInstructions || baseParts.length === 0) {
      return baseParts;
    }

    const capabilitiesDocs = this.buildCapabilitiesDocs(
      tools ?? agentConfig.tools,
      subAgents ?? agentConfig.sub_agents,
    );
    const first = baseParts[0]!;
    baseParts[0] = {
      text: `${first.text}${capabilitiesDocs}${TOOL_EXECUTION_INSTRUCTIONS}`,
      cache: first.cache,
    };
    return baseParts;
  }

  private getBaseSystemPrompt(
    agentConfig: AgentConfig,
    runtimeContext: Record<string, unknown>,
  ): SystemPromptPart[] {
    const blocks = normalizeSystemPromptBlocks(agentConfig.system_prompt);
    if (blocks.length === 0) {
      return [
        {
          text: this.promptHandler.createDynamicPrompt(
            DEFAULT_SYSTEM_PROMPT_TEMPLATE,
            agentConfig,
            runtimeContext,
            "string",
          ),
          cache: true,
        },
      ];
    }

    const parts: SystemPromptPart[] = blocks.map((item) => {
      const block: SystemPromptBlock =
        typeof item === "string" ? { content: item, cache: true } : item;
      return {
        text: this.promptHandler.createDynamicPrompt(
          block.content,
          agentConfig,
          runtimeContext,
          agentConfig.system_prompt_type,
        ),
        cache: block.cache,
      };
    });

    this.appendSuffixAndNexauMd(parts, agentConfig, runtimeContext);
    return parts;
  }

  private appendSuffixAndNexauMd(
    parts: SystemPromptPart[],
    agentConfig: AgentConfig,
    runtimeContext: Record<string, unknown>,
  ): void {
    if (parts.length === 0) {
      return;
    }
    let extra = "";
    if (agentConfig.system_prompt_suffix) {
      extra += agentConfig.system_prompt_suffix;
    }
    const nexauMd = this.loadNexauMd(agentConfig, runtimeContext);
    if (nexauMd) {
      extra += `\n\n# Project Instructions (NEXAU.md)\n\n${nexauMd}`;
    }
    if (!extra) {
      return;
    }
    const last = parts[parts.length - 1]!;
    parts[parts.length - 1] = {
      text: `${last.text}${extra}`,
      cache: last.cache,
    };
  }

  private loadNexauMd(
    agentConfig: AgentConfig,
    runtimeContext: Record<string, unknown>,
  ): string | null {
    const cwd =
      (typeof runtimeContext.working_directory === "string" && runtimeContext.working_directory) ||
      (agentConfig.sandbox_config &&
      typeof agentConfig.sandbox_config === "object" &&
      typeof (agentConfig.sandbox_config as Record<string, unknown>).work_dir === "string"
        ? ((agentConfig.sandbox_config as Record<string, unknown>).work_dir as string)
        : null);
    if (!cwd) {
      return null;
    }
    const nexauMdPath = join(cwd, "NEXAU.md");
    if (!existsSync(nexauMdPath)) {
      return null;
    }
    const content = readFileSync(nexauMdPath, "utf-8").trim();
    return content.length > 0 ? content : null;
  }

  private buildCapabilitiesDocs(tools: Tool[], subAgents: Record<string, AgentConfig>): string {
    const docs: string[] = [];
    if (tools.length > 0) {
      docs.push(this.buildToolsDocumentation(tools));
    }
    if (Object.keys(subAgents).length > 0) {
      docs.push(this.buildSubAgentsDocumentation(subAgents));
    }
    return docs.join("\n");
  }

  private extractToolParameters(tool: Tool): ToolParameter[] {
    const schema = tool.inputSchema;
    const properties =
      typeof schema.properties === "object" && schema.properties
        ? (schema.properties as Record<string, unknown>)
        : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : [],
    );

    const parameters: ToolParameter[] = [];
    for (const [name, rawInfo] of Object.entries(properties)) {
      const info =
        typeof rawInfo === "object" && rawInfo !== null ? (rawInfo as Record<string, unknown>) : {};
      const jsonType = typeof info.type === "string" ? info.type : "string";
      parameters.push({
        name,
        description:
          typeof info.description === "string" && info.description.trim().length > 0
            ? info.description.trim()
            : "",
        type: toPythonType(jsonType),
        required: required.has(name),
        default: info.default,
      });
    }
    return parameters;
  }

  private buildToolsDocumentation(tools: Tool[]): string {
    const lines: string[] = ["", "## Available Tools", "You can use tools by including XML blocks in your response:"];
    for (const tool of tools) {
      lines.push("", `### ${tool.name}`);
      if (tool.asSkill) {
        lines.push(tool.skillDescription ?? "No skill description available");
        continue;
      }
      if (tool.templateOverride) {
        lines.push(tool.templateOverride);
        continue;
      }
      lines.push(tool.description || "No description available");
      lines.push("Usage:");
      lines.push("<tool_use>");
      lines.push(`  <tool_name>${tool.name}</tool_name>`);
      lines.push("  <parameter>");
      const parameters = this.extractToolParameters(tool);
      for (const param of parameters) {
        const optionalType = param.required
          ? `required, type: ${param.type}`
          : `optional, type: ${param.type}${param.default ? `, default: ${String(param.default)}` : ""}`;
        lines.push(`    <${param.name}>${param.description} (${optionalType})</${param.name}>`);
      }
      lines.push("  </parameter>");
      lines.push("</tool_use>");
    }
    return lines.join("\n");
  }

  private buildSubAgentsDocumentation(subAgents: Record<string, AgentConfig>): string {
    const names = Object.keys(subAgents);
    if (names.length === 0) {
      return "";
    }
    const lines: string[] = ["", "## Available Sub-Agents", "You can delegate tasks to specialized sub-agents:"];
    for (const name of names) {
      const description =
        subAgents[name]?.description ?? `Specialized agent for ${name}-related tasks`;
      lines.push("");
      lines.push(`<description_of_sub_agent:${name}>`);
      lines.push(`### ${name}`);
      lines.push(description);
      lines.push("Usage:");
      lines.push("<tool_use>");
      lines.push(`  <tool_name>agent:${name}</tool_name>`);
      lines.push("  <parameter>");
      lines.push("    <message>task description</message>");
      lines.push("  </parameter>");
      lines.push("</tool_use>");
      lines.push(`</description_of_sub_agent:${name}>`);
    }
    return lines.join("\n");
  }
}
