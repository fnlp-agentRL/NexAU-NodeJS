import type { AgentConfig } from "./agent-config.js";
import { AgentExecutor } from "./execution/executor.js";
import type { ExecuteOptions, ExecutionResult, ExecutorDeps } from "./execution/types.js";
import { initializeMcpTools } from "../tool/builtin/mcp-client.js";

interface AgentRunOptions {
  history?: ExecuteOptions["history"];
  systemPromptAddition?: ExecuteOptions["systemPromptAddition"];
  agentState?: ExecuteOptions["agentState"];
  signal?: ExecuteOptions["signal"];
  traceContext?: ExecuteOptions["traceContext"];
  onEvent?: ExecuteOptions["onEvent"];
}

export class Agent {
  public readonly config: AgentConfig;
  private readonly executor: AgentExecutor;
  private mcpInitialized = false;
  private mcpInitPromise: Promise<void> | null = null;

  public constructor(config: AgentConfig, deps: ExecutorDeps) {
    this.config = config;
    this.executor = new AgentExecutor(deps);
  }

  private async ensureMcpToolsLoaded(): Promise<void> {
    if (this.mcpInitialized) {
      return;
    }
    if (this.mcpInitPromise) {
      await this.mcpInitPromise;
      return;
    }

    this.mcpInitPromise = (async () => {
      if (!Array.isArray(this.config.mcp_servers) || this.config.mcp_servers.length === 0) {
        this.mcpInitialized = true;
        return;
      }

      const mcpTools = await initializeMcpTools(this.config.mcp_servers);
      if (mcpTools.length > 0) {
        const existingNames = new Set(this.config.tools.map((tool) => tool.name));
        for (const tool of mcpTools) {
          if (!existingNames.has(tool.name)) {
            this.config.tools.push(tool);
            existingNames.add(tool.name);
          }
        }
      }
      this.mcpInitialized = true;
    })();

    try {
      await this.mcpInitPromise;
    } finally {
      this.mcpInitPromise = null;
    }
  }

  public async run(input: string, options: AgentRunOptions = {}): Promise<ExecutionResult> {
    await this.ensureMcpToolsLoaded();

    return this.executor.execute({
      agent: this.config,
      input,
      history: options.history,
      systemPromptAddition: options.systemPromptAddition,
      agentState: options.agentState,
      signal: options.signal,
      traceContext: options.traceContext,
      onEvent: options.onEvent,
    });
  }
}
