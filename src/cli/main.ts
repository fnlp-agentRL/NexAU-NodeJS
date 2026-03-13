#!/usr/bin/env node
import { Command } from "commander";

import { runChatCommand } from "./commands/chat.js";
import { runServeHttpCommand } from "./commands/serve-http.js";
import { runServeStdioCommand } from "./commands/serve-stdio.js";

export function createProgram(): Command {
  const program = new Command();
  program.name("nexau");

  program
    .command("chat")
    .description("Run chat mode (interactive or single-shot)")
    .requiredOption("-c, --config <path>", "Agent yaml config path")
    .option("-m, --message <text>", "Single-turn user message")
    .option("--stream", "Print execution events")
    .option("--user-id <id>", "User id for session separation")
    .option("--session-id <id>", "Session id for session separation")
    .option("--session-db <path>", "Sqlite path for persisted sessions")
    .action(async (options) => {
      const code = await runChatCommand({
        config: options.config,
        message: options.message,
        stream: Boolean(options.stream),
        userId: options.userId,
        sessionId: options.sessionId,
        sessionDbPath: options.sessionDb,
      });
      process.exitCode = code;
    });

  const serve = program.command("serve").description("Run transport servers");

  serve
    .command("http")
    .requiredOption("-c, --config <path>", "Agent yaml config path")
    .option("--host <host>", "Listen host", "127.0.0.1")
    .option("--port <port>", "Listen port", (value) => Number(value), 8787)
    .option("--session-db <path>", "Sqlite path for persisted sessions")
    .action(async (options) => {
      await runServeHttpCommand({
        config: options.config,
        host: options.host,
        port: options.port,
        sessionDbPath: options.sessionDb,
      });
    });

  serve
    .command("stdio")
    .requiredOption("-c, --config <path>", "Agent yaml config path")
    .option("--session-db <path>", "Sqlite path for persisted sessions")
    .action((options) => {
      runServeStdioCommand({
        config: options.config,
        sessionDbPath: options.sessionDb,
      });
    });

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createProgram().parseAsync(process.argv);
}
