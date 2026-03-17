import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentConfig } from "./agent-config.js";

type PromptType = "string" | "file" | "jinja";

type AgentContextSource = Pick<AgentConfig, "name" | "system_prompt_type"> & {
  agent_id?: string;
};

const TEMPLATE_VAR_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function resolveContextPath(context: Record<string, unknown>, path: string): unknown {
  const tokens = path.split(".").filter((token) => token.length > 0);
  let current: unknown = context;
  for (const token of tokens) {
    if (!current || typeof current !== "object" || !(token in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(TEMPLATE_VAR_PATTERN, (_match, rawPath: string) => {
    const value = resolveContextPath(context, rawPath);
    if (value === null || value === undefined) {
      return "";
    }
    return String(value);
  });
}

export class PromptHandler {
  public validatePromptType(promptType: string): promptType is PromptType {
    return promptType === "string" || promptType === "file" || promptType === "jinja";
  }

  private processStringPrompt(prompt: string, context?: Record<string, unknown>): string {
    if (!prompt) {
      return "";
    }
    if (!context) {
      return prompt;
    }
    return renderTemplate(prompt, context);
  }

  private processJinjaPrompt(templatePath: string, context?: Record<string, unknown>): string {
    const content = readFileSync(resolve(templatePath), "utf-8");
    return this.processStringPrompt(content, context).trim();
  }

  public processPrompt(
    prompt: string,
    promptType: PromptType = "string",
    context?: Record<string, unknown>,
  ): string {
    if (!this.validatePromptType(promptType)) {
      throw new Error(`Invalid prompt type: ${promptType}`);
    }
    if (promptType === "string") {
      return this.processStringPrompt(prompt, context);
    }
    return this.processJinjaPrompt(prompt, context);
  }

  public getDefaultContext(agent: AgentContextSource): Record<string, unknown> {
    return {
      agent_name: agent.name ?? "Unknown Agent",
      timestamp: new Date().toISOString(),
      agent_id: agent.agent_id ?? null,
      system_prompt_type: agent.system_prompt_type ?? "string",
    };
  }

  public createDynamicPrompt(
    baseTemplate: string,
    agent: AgentContextSource,
    additionalContext: Record<string, unknown> | undefined,
    templateType: PromptType,
  ): string {
    if (!this.validatePromptType(templateType)) {
      throw new Error(`Invalid template type: ${templateType}`);
    }
    const context = {
      ...this.getDefaultContext(agent),
      ...(additionalContext ?? {}),
    };
    return this.processPrompt(baseTemplate, templateType, context);
  }
}
