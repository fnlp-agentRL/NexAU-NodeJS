import type { AgentConfig } from "../agent-config.js";
import { AnthropicLLMClient } from "../llm/anthropic-client.js";
import { OpenAICompatibleLLMClient } from "../llm/openai-compatible-client.js";
import type { ExecutorDeps, LLMClient } from "./types.js";

export function createDefaultExecutorDeps(): ExecutorDeps {
  return {
    createLLMClient(agent: AgentConfig): LLMClient {
      if (agent.llm_config.api_type === "anthropic_chat_completion") {
        return new AnthropicLLMClient(agent.llm_config);
      }
      return new OpenAICompatibleLLMClient(agent.llm_config);
    },
  };
}
