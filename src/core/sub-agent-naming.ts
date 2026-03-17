export const SUB_AGENT_TOOL_PREFIX = "sub-agent-";
export const LEGACY_SUB_AGENT_TOOL_PREFIX = "agent:";

export function buildSubAgentToolName(agentName: string): string {
  return `${SUB_AGENT_TOOL_PREFIX}${agentName}`;
}

export function isSubAgentToolName(name: string | null | undefined): boolean {
  if (!name) {
    return false;
  }
  return name.startsWith(SUB_AGENT_TOOL_PREFIX) || name.startsWith(LEGACY_SUB_AGENT_TOOL_PREFIX);
}

export function extractSubAgentName(name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }
  if (name.startsWith(SUB_AGENT_TOOL_PREFIX)) {
    return name.slice(SUB_AGENT_TOOL_PREFIX.length);
  }
  if (name.startsWith(LEGACY_SUB_AGENT_TOOL_PREFIX)) {
    return name.slice(LEGACY_SUB_AGENT_TOOL_PREFIX.length);
  }
  return null;
}
