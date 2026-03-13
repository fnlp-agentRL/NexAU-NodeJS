import { describe, expect, it } from "vitest";

import { createProgram } from "./main.js";

describe("CLI program", () => {
  it("registers chat and serve commands", () => {
    const program = createProgram();
    const top = program.commands.map((command) => command.name());

    expect(top).toContain("chat");
    expect(top).toContain("serve");

    const serve = program.commands.find((command) => command.name() === "serve");
    const serveSub = serve?.commands.map((command) => command.name()) ?? [];

    expect(serveSub).toContain("http");
    expect(serveSub).toContain("stdio");
  });
});
