import { describe, expect, it } from "vitest";

import { AgentConfig } from "../agent-config.js";
import { createDefaultExecutorDeps } from "./default-deps.js";

describe("createDefaultExecutorDeps", () => {
  it("creates llm client for an agent", () => {
    const agent = {
      llm_config: {
        model: "m",
        base_url: "https://example.com/v1",
        api_key: "k",
        api_type: "openai_chat_completion",
        extra_params: {},
      },
    } as unknown as AgentConfig;

    const deps = createDefaultExecutorDeps();
    const client = deps.createLLMClient(agent);
    expect(typeof client.complete).toBe("function");
  });
});
