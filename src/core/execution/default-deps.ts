import type { AgentConfig } from "../agent-config.js";
import { OpenAICompatibleLLMClient } from "../llm/openai-compatible-client.js";
import type { ExecutorDeps, LLMClient } from "./types.js";

export function createDefaultExecutorDeps(): ExecutorDeps {
  return {
    createLLMClient(agent: AgentConfig): LLMClient {
      return new OpenAICompatibleLLMClient(agent.llm_config);
    },
  };
}
