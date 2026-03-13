import { describe, expect, it } from "vitest";

import { ConfigError } from "./config-error.js";
import { LLMConfig } from "./llm-config.js";

describe("LLMConfig", () => {
  it("reads required fields from env fallback", () => {
    const config = new LLMConfig(
      {
        max_tokens: 1024,
      },
      {
        env: {
          MODEL: "model-a",
          OPENAI_BASE_URL: "https://example.com/v1",
          LLM_API_KEY: "key-a",
        },
      },
    );

    expect(config.model).toBe("model-a");
    expect(config.base_url).toBe("https://example.com/v1");
    expect(config.api_key).toBe("key-a");
    expect(config.max_tokens).toBe(1024);
  });

  it("throws when required env fields are missing", () => {
    expect(() => new LLMConfig({}, { env: {} })).toThrowError(ConfigError);
  });

  it("drops parameters configured in additional_drop_params", () => {
    const config = new LLMConfig(
      {
        model: "test-model",
        base_url: "https://example.com/v1",
        api_key: "test-key",
        temperature: 0.2,
        additional_drop_params: ["temperature"],
      },
      {},
    );

    expect(config.toOpenAIParams()).toEqual({
      model: "test-model",
    });
  });
});
