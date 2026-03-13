import type { LLMConfig } from "../llm-config.js";
import type { ChatMessage, LLMClient, LLMCompleteInput, LLMResponse } from "../execution/types.js";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizeEndpoint(baseUrl: string, path: string): string {
  const root = normalizeBaseUrl(baseUrl);
  if (root.endsWith("/v1")) {
    return `${root}${path}`;
  }
  return `${root}/v1${path}`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }

  return "";
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  return {};
}

function toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        name: message.name,
        content: message.content,
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

function parseChatCompletionResponse(raw: Record<string, unknown>): LLMResponse {
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  const firstChoice = choices[0] as { message?: Record<string, unknown> } | undefined;
  const message = (firstChoice?.message ?? {}) as Record<string, unknown>;

  const content = extractTextContent(message.content);
  const toolCallsRaw = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const tool_calls = toolCallsRaw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const typed = item as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const name = typeof typed.function?.name === "string" ? typed.function.name : null;
      if (!name) {
        return null;
      }
      return {
        id: typeof typed.id === "string" ? typed.id : `tool-${Math.random().toString(36).slice(2)}`,
        name,
        arguments: parseToolArguments(typed.function?.arguments),
      };
    })
    .filter(
      (item): item is { id: string; name: string; arguments: Record<string, unknown> } =>
        item !== null,
    );

  return {
    content,
    tool_calls,
  };
}

function parseResponsesApiResponse(raw: Record<string, unknown>): LLMResponse {
  const content = typeof raw.output_text === "string" ? raw.output_text : "";
  const output = Array.isArray(raw.output) ? raw.output : [];

  const tool_calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const typed = item as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
      call_id?: unknown;
      content?: unknown;
    };

    if (typed.type === "function_call" && typeof typed.name === "string") {
      tool_calls.push({
        id:
          typeof typed.call_id === "string"
            ? typed.call_id
            : typeof typed.id === "string"
              ? typed.id
              : `tool-${Math.random().toString(36).slice(2)}`,
        name: typed.name,
        arguments: parseToolArguments(typed.arguments),
      });
    }
  }

  if (content.length > 0 || tool_calls.length > 0) {
    return {
      content,
      tool_calls,
    };
  }

  return {
    content: extractTextContent(raw.output),
    tool_calls,
  };
}

function selectApiPath(config: LLMConfig): "/chat/completions" | "/responses" {
  if (config.api_type === "openai_responses") {
    return "/responses";
  }
  return "/chat/completions";
}

export class OpenAICompatibleLLMClient implements LLMClient {
  private readonly config: LLMConfig;

  public constructor(config: LLMConfig) {
    this.config = config;
  }

  public async complete(input: LLMCompleteInput): Promise<LLMResponse> {
    const path = selectApiPath(this.config);
    const endpoint = normalizeEndpoint(this.config.base_url, path);

    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages: toOpenAIMessages(input.messages),
      stream: false,
      ...this.config.extra_params,
    };

    if (this.config.temperature !== undefined) {
      payload.temperature = this.config.temperature;
    }
    if (this.config.max_tokens !== undefined) {
      payload.max_tokens = this.config.max_tokens;
    }
    if (input.tools.length > 0) {
      payload.tools = input.tools;
      payload.tool_choice = "auto";
    }

    if (path === "/responses") {
      payload.input = payload.messages;
      delete payload.messages;
      if (payload.max_tokens !== undefined) {
        payload.max_output_tokens = payload.max_tokens;
        delete payload.max_tokens;
      }
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.api_key}`,
      },
      body: JSON.stringify(payload),
      signal: this.config.timeout ? AbortSignal.timeout(this.config.timeout * 1000) : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    return path === "/responses"
      ? parseResponsesApiResponse(json)
      : parseChatCompletionResponse(json);
  }
}
