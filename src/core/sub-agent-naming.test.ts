import { describe, expect, it } from "vitest";

import {
  buildSubAgentToolName,
  extractSubAgentName,
  isSubAgentToolName,
} from "./sub-agent-naming.js";

describe("sub-agent naming helpers", () => {
  it("builds and recognizes canonical and legacy sub-agent names", () => {
    expect(buildSubAgentToolName("researcher")).toBe("sub-agent-researcher");
    expect(isSubAgentToolName("sub-agent-researcher")).toBe(true);
    expect(isSubAgentToolName("agent:researcher")).toBe(true);
    expect(isSubAgentToolName("researcher")).toBe(false);
    expect(isSubAgentToolName("")).toBe(false);
    expect(isSubAgentToolName(undefined)).toBe(false);
  });

  it("extracts logical sub-agent name from tool names", () => {
    expect(extractSubAgentName("sub-agent-researcher")).toBe("researcher");
    expect(extractSubAgentName("agent:researcher")).toBe("researcher");
    expect(extractSubAgentName("plain_tool")).toBeNull();
    expect(extractSubAgentName(undefined)).toBeNull();
  });
});
