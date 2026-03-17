import { beforeEach, describe, expect, it, vi } from "vitest";

import { LLMConfig } from "../llm-config.js";
import { AnthropicLLMClient } from "./anthropic-client.js";

describe("AnthropicLLMClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses text and tool_use blocks from anthropic response", async () => {
    const config = new LLMConfig({
      model: "claude-test",
      base_url: "https://api.anthropic.com",
      api_key: "test-key",
      api_type: "anthropic_chat_completion",
      max_tokens: 128,
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      async json() {
        return {
          content: [
            "ignored-non-object",
            { type: "text", text: "hello" },
            { type: "tool_use", id: "tu_1", name: "write_todos", input: { todos: [] } },
          ],
        };
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new AnthropicLLMClient(config);
    const result = await client.complete({
      agent: {} as never,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "write_todos", input_schema: { type: "object", properties: {} } }],
    });

    expect(result.content).toBe("hello");
    expect(result.tool_calls?.[0]?.name).toBe("write_todos");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("converts system/assistant tool calls/tool results to anthropic message format", async () => {
    const config = new LLMConfig({
      model: "claude-test",
      base_url: "https://api.anthropic.com/v1",
      api_key: "test-key",
      api_type: "anthropic_chat_completion",
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.9,
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      async json() {
        return {
          content: [{ type: "text", text: "done" }],
        };
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new AnthropicLLMClient(config);
    await client.complete({
      agent: {} as never,
      messages: [
        { role: "system", content: "System rule" },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "calling tool",
          tool_calls: [{ id: "t1", name: "write_todos", arguments: { todos: [] } }],
        },
        {
          role: "tool",
          tool_call_id: "t1",
          content: "tool ok plain text",
        },
      ],
      tools: [{ name: "write_todos", input_schema: { type: "object", properties: {} } }],
    });

    const call = fetchMock.mock.calls[0] as unknown[] | undefined;
    const init = call?.[1] as { body?: string } | undefined;
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    expect(body.system).toBe("System rule");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
  });

  it("throws on non-2xx anthropic responses", async () => {
    const config = new LLMConfig({
      model: "claude-test",
      base_url: "https://api.anthropic.com",
      api_key: "test-key",
      api_type: "anthropic_chat_completion",
      max_tokens: 128,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        async text() {
          return "rate limit";
        },
      })),
    );

    const client = new AnthropicLLMClient(config);
    await expect(
      client.complete({
        agent: {} as never,
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    ).rejects.toThrow("LLM request failed");
  });
});
