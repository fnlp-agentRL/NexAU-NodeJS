import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { AgentConfig } from "../../core/agent-config.js";
import { Agent } from "../../core/agent.js";
import { createDefaultExecutorDeps } from "../../core/execution/default-deps.js";
import type { ExecutorDeps } from "../../core/execution/types.js";
import { createSessionManager } from "../../session/create-session-manager.js";
import { RuntimeService } from "../../transport/runtime-service.js";

export interface ChatCommandOptions {
  config: string;
  message?: string;
  stream?: boolean;
  userId?: string;
  sessionId?: string;
  runtime?: RuntimeService;
  deps?: ExecutorDeps;
  sessionDbPath?: string;
}

async function runSingleTurn(
  runtime: RuntimeService,
  options: ChatCommandOptions,
): Promise<number> {
  const message = options.message ?? "";
  const userId = options.userId ?? "cli-user";
  const sessionId = options.sessionId ?? "cli-session";

  const result = await runtime.query(
    {
      input: message,
      user_id: userId,
      session_id: sessionId,
    },
    options.stream
      ? (event) => {
          output.write(`[${event.type}] ${JSON.stringify(event.payload)}\n`);
        }
      : undefined,
  );

  output.write(`${result.output}\n`);
  return result.status === "failed" ? 1 : 0;
}

async function runInteractive(
  runtime: RuntimeService,
  options: ChatCommandOptions,
): Promise<number> {
  const rl = readline.createInterface({
    input,
    output,
  });

  const userId = options.userId ?? "cli-user";
  const sessionId = options.sessionId ?? "cli-session";

  try {
    while (true) {
      const line = await rl.question("> ");
      const normalized = line.trim();
      if (normalized === "/exit" || normalized === "/quit") {
        break;
      }

      const result = await runtime.query(
        {
          input: line,
          user_id: userId,
          session_id: sessionId,
        },
        options.stream
          ? (event) => {
              output.write(`[${event.type}] ${JSON.stringify(event.payload)}\n`);
            }
          : undefined,
      );

      output.write(`${result.output}\n`);
    }
  } finally {
    rl.close();
  }

  return 0;
}

export async function runChatCommand(options: ChatCommandOptions): Promise<number> {
  const runtime =
    options.runtime ??
    (() => {
      const config = AgentConfig.fromYaml(options.config);
      const agent = new Agent(config, options.deps ?? createDefaultExecutorDeps());
      return new RuntimeService(agent, createSessionManager(options.sessionDbPath));
    })();

  if (options.message !== undefined) {
    return runSingleTurn(runtime, options);
  }

  return runInteractive(runtime, options);
}
