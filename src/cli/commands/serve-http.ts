import type { Server } from "node:http";

import { AgentConfig } from "../../core/agent-config.js";
import { Agent } from "../../core/agent.js";
import { createDefaultExecutorDeps } from "../../core/execution/default-deps.js";
import { createSessionManager } from "../../session/create-session-manager.js";
import { createHttpServer } from "../../transport/http/server.js";
import { RuntimeService } from "../../transport/runtime-service.js";

export interface ServeHttpCommandOptions {
  config: string;
  host?: string;
  port?: number;
  runtime?: RuntimeService;
  sessionDbPath?: string;
}

export async function runServeHttpCommand(options: ServeHttpCommandOptions): Promise<Server> {
  const runtime =
    options.runtime ??
    (() => {
      const config = AgentConfig.fromYaml(options.config);
      const agent = new Agent(config, createDefaultExecutorDeps());
      return new RuntimeService(agent, createSessionManager(options.sessionDbPath));
    })();
  const server = createHttpServer({ runtime });

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  process.stdout.write(`HTTP server listening on http://${host}:${port}\n`);
  return server;
}
