import type { LLMConfig } from "../llm-config.js";
import type { ChatMessage, LLMClient, LLMCompleteInput, LLMResponse } from "../execution/types.js";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizeEndpoint(baseUrl: string): string {
  const root = normalizeBaseUrl(baseUrl);
  if (root.endsWith("/v1")) {
    return `${root}/messages`;
  }
  return `${root}/v1/messages`;
}

function parseToolResultContent(raw: string): string | Array<{ type: "text"; text: string }> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (item) =>
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string",
      )
    ) {
      return parsed as Array<{ type: "text"; text: string }>;
    }
  } catch {
    // Ignore JSON parse failures and pass raw text to Anthropic.
  }
  return raw;
}

function toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: parseToolResultContent(message.content),
          },
        ],
      });
      continue;
    }

    if (
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      const contentBlocks: Array<Record<string, unknown>> = [];
      if (message.content && message.content !== "null") {
        contentBlocks.push({
          type: "text",
          text: message.content,
        });
      }
      for (const toolCall of message.tool_calls) {
        contentBlocks.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments ?? {},
        });
      }
      converted.push({
        role: "assistant",
        content: contentBlocks,
      });
      continue;
    }

    converted.push({
      role: message.role,
      content: message.content,
    });
  }
  return converted;
}

function parseAnthropicResponse(raw: Record<string, unknown>): LLMResponse {
  const content = Array.isArray(raw.content) ? raw.content : [];
  const textParts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const typed = item as {
      type?: unknown;
      text?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };

    if (typed.type === "text" && typeof typed.text === "string") {
      textParts.push(typed.text);
      continue;
    }

    if (typed.type === "tool_use" && typeof typed.name === "string") {
      toolCalls.push({
        id: typeof typed.id === "string" ? typed.id : `tool-${Math.random().toString(36).slice(2)}`,
        name: typed.name,
        arguments:
          typed.input && typeof typed.input === "object" && !Array.isArray(typed.input)
            ? (typed.input as Record<string, unknown>)
            : {},
      });
    }
  }

  return {
    content: textParts.join(""),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

export class AnthropicLLMClient implements LLMClient {
  private readonly config: LLMConfig;

  public constructor(config: LLMConfig) {
    this.config = config;
  }

  public async complete(input: LLMCompleteInput): Promise<LLMResponse> {
    const endpoint = normalizeEndpoint(this.config.base_url);
    const systemPrompt = input.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n")
      .trim();

    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages: toAnthropicMessages(input.messages),
      max_tokens: this.config.max_tokens ?? 4096,
      ...this.config.extra_params,
    };
    if (systemPrompt.length > 0) {
      payload.system = systemPrompt;
    }
    if (this.config.temperature !== undefined) {
      payload.temperature = this.config.temperature;
    }
    if (this.config.top_p !== undefined) {
      payload.top_p = this.config.top_p;
    }
    if (input.tools.length > 0) {
      payload.tools = input.tools;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: this.config.timeout ? AbortSignal.timeout(this.config.timeout * 1000) : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    return parseAnthropicResponse(json);
  }
}
