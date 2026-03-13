import { describe, expect, it, vi } from "vitest";

vi.mock("./commands/chat.js", () => ({
  runChatCommand: vi.fn(async () => 0),
}));
vi.mock("./commands/serve-http.js", () => ({
  runServeHttpCommand: vi.fn(async () => undefined),
}));
vi.mock("./commands/serve-stdio.js", () => ({
  runServeStdioCommand: vi.fn(() => undefined),
}));

describe("CLI actions", () => {
  it("dispatches chat and serve actions", async () => {
    const { createProgram } = await import("./main.js");
    const chatModule = await import("./commands/chat.js");
    const httpModule = await import("./commands/serve-http.js");
    const stdioModule = await import("./commands/serve-stdio.js");

    await createProgram().parseAsync([
      "node",
      "nexau",
      "chat",
      "--config",
      "agent.yaml",
      "--message",
      "hello",
    ]);
    expect(chatModule.runChatCommand).toHaveBeenCalled();

    await createProgram().parseAsync([
      "node",
      "nexau",
      "serve",
      "http",
      "--config",
      "agent.yaml",
      "--port",
      "18888",
    ]);
    expect(httpModule.runServeHttpCommand).toHaveBeenCalled();

    await createProgram().parseAsync(["node", "nexau", "serve", "stdio", "--config", "agent.yaml"]);
    expect(stdioModule.runServeStdioCommand).toHaveBeenCalled();
  });
});
