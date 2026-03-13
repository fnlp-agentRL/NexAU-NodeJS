import { beforeEach, describe, expect, it, vi } from "vitest";

import { LLMConfig } from "../llm-config.js";
import { OpenAICompatibleLLMClient } from "./openai-compatible-client.js";

const baseConfig = new LLMConfig({
  model: "test-model",
  base_url: "https://example.com/v1",
  api_key: "test-key",
});

describe("OpenAICompatibleLLMClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses chat completion responses with tool calls", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "assistant message",
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "write_todos",
                      arguments: '{"todos":[{"description":"a","status":"pending"}]}',
                    },
                  },
                ],
              },
            },
          ],
        };
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAICompatibleLLMClient(baseConfig);
    const result = await client.complete({
      agent: {} as never,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "write_todos" } }],
    });

    expect(result.content).toBe("assistant message");
    expect(result.tool_calls?.[0]?.name).toBe("write_todos");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown[] | undefined;
    if (!call || call.length === 0) {
      throw new Error("expected fetch to be called");
    }
    const url = call[0];
    const init = call[1];
    if (typeof url !== "string") {
      throw new Error("expected fetch url to be a string");
    }
    const bodyValue =
      init && typeof init === "object" && "body" in init
        ? (init as Record<string, unknown>).body
        : undefined;
    const body = typeof bodyValue === "string" ? bodyValue : "";
    expect(url).toBe("https://example.com/v1/chat/completions");
    expect(body).toContain("tool_choice");
  });

  it("parses responses api payloads", async () => {
    const responsesConfig = new LLMConfig({
      model: "test-model",
      base_url: "https://example.com",
      api_key: "test-key",
      api_type: "openai_responses",
      max_tokens: 32,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        async json() {
          return {
            output_text: "response output",
            output: [
              {
                type: "function_call",
                id: "f1",
                name: "write_todos",
                arguments: { todos: [] },
              },
            ],
          };
        },
      })),
    );

    const client = new OpenAICompatibleLLMClient(responsesConfig);
    const result = await client.complete({
      agent: {} as never,
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(result.content).toBe("response output");
    expect(result.tool_calls?.[0]?.id).toBe("f1");
  });

  it("throws on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        async text() {
          return "bad request";
        },
      })),
    );

    const client = new OpenAICompatibleLLMClient(baseConfig);
    await expect(
      client.complete({
        agent: {} as never,
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    ).rejects.toThrow("LLM request failed");
  });
});
