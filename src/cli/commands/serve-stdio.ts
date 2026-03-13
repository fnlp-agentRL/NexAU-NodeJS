import type { Readable, Writable } from "node:stream";

import { AgentConfig } from "../../core/agent-config.js";
import { Agent } from "../../core/agent.js";
import { createDefaultExecutorDeps } from "../../core/execution/default-deps.js";
import { createSessionManager } from "../../session/create-session-manager.js";
import { startStdioServer } from "../../transport/stdio/server.js";
import { RuntimeService } from "../../transport/runtime-service.js";

export interface ServeStdioCommandOptions {
  config: string;
  runtime?: RuntimeService;
  input?: Readable;
  output?: Writable;
  sessionDbPath?: string;
}

export function runServeStdioCommand(options: ServeStdioCommandOptions): void {
  const runtime =
    options.runtime ??
    (() => {
      const config = AgentConfig.fromYaml(options.config);
      const agent = new Agent(config, createDefaultExecutorDeps());
      return new RuntimeService(agent, createSessionManager(options.sessionDbPath));
    })();

  startStdioServer({
    runtime,
    input: options.input,
    output: options.output,
  });
}
