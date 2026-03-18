import type { Tool } from "../../../tool/tool.js";
import type { ChatMessage } from "../types.js";
import type { ToolSelector, ToolSelectorInput, ToolSelectorResult } from "./types.js";

interface HybridSelectorOptions {
  enabled?: boolean;
  top_k?: number;
  per_domain_k?: number;
  domains?: Record<string, unknown>;
  allow_tools?: unknown;
  deny_tools?: unknown;
  readonly_mode?: boolean;
  risky_write_tools?: unknown;
  always_include_tools?: unknown;
  single_tool_name?: unknown;
  single_tool_after_iteration?: unknown;
}

interface ScoredTool {
  tool: Tool;
  domain: string;
  lexicalScore: number;
  paramScore: number;
  sessionScore: number;
  domainSignalScore: number;
  score: number;
}

interface LinkSignals {
  links: string[];
  domainBoosts: Map<string, number>;
  signalTokens: Set<string>;
}

const WRITE_ACTION_HINTS = [
  "create",
  "update",
  "delete",
  "patch",
  "append",
  "batch_create",
  "batch_update",
  "batch_delete",
  "copy",
  "write",
];

const DEFAULT_DOMAIN_HINTS: Record<string, string[]> = {
  docs: ["docs", "document", "doc", "wiki", "文档", "知识库"],
  base: ["base", "bitable", "record", "table", "多维表", "数据表"],
  sheets: ["sheets", "spreadsheet", "sheet", "excel", "表格", "单元格"],
  calendar: ["calendar", "event", "schedule", "freebusy", "日程", "日历", "会议"],
  tasks: ["tasks", "task", "todo", "subtask", "任务", "待办"],
  messenger: ["messenger", "message", "chat", "reply", "消息", "聊天", "回复"],
};

const URL_PATTERN =
  /(https?:\/\/[^\s<>"'`]+|(?:[a-z0-9-]+\.)?(?:feishu\.cn|larksuite\.com)\/[^\s<>"'`]+)/giu;
const TRAILING_URL_PUNCTUATION = /[),.;!?]+$/u;
const PARAM_HINT_KEYS = [
  "app_token",
  "table_id",
  "record_id",
  "field_id",
  "view_id",
  "document_id",
  "block_id",
  "message_id",
  "reaction_id",
  "file_key",
  "spreadsheet_token",
  "sheet_id",
  "calendar_id",
  "event_id",
  "task_guid",
  "task_id",
  "tasklist_guid",
  "comment_id",
];

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu);
  if (!matches) {
    return [];
  }
  return matches.filter((item) => item.length > 0);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      parsed.push(item);
    }
  }
  return parsed;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function normalizeUrlCandidate(raw: string): string {
  return raw.trim().replace(TRAILING_URL_PUNCTUATION, "");
}

function bumpDomainScore(target: Map<string, number>, domain: string, score: number): void {
  target.set(domain, (target.get(domain) ?? 0) + score);
}

function extractLinkSignals(text: string): LinkSignals {
  const links: string[] = [];
  const domainBoosts = new Map<string, number>();
  const signalTokens = new Set<string>();

  for (const key of PARAM_HINT_KEYS) {
    if (text.toLowerCase().includes(key)) {
      signalTokens.add(key);
    }
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = normalizeUrlCandidate(match[1] ?? "");
    if (raw.length === 0) {
      continue;
    }

    const withScheme =
      raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      continue;
    }

    const host = parsed.host.toLowerCase();
    if (!host.includes("feishu.cn") && !host.includes("larksuite.com")) {
      continue;
    }

    links.push(parsed.toString());
    const pathname = parsed.pathname.toLowerCase();

    if (pathname.includes("/base/") || pathname.includes("/bitable/")) {
      bumpDomainScore(domainBoosts, "base", 8);
      signalTokens.add("app_token");
    }
    if (pathname.includes("/docx/") || pathname.includes("/docs/") || pathname.includes("/wiki/")) {
      bumpDomainScore(domainBoosts, "docs", 8);
      signalTokens.add("document_id");
    }
    if (pathname.includes("/sheets/") || pathname.includes("/sheet/")) {
      bumpDomainScore(domainBoosts, "sheets", 8);
      signalTokens.add("spreadsheet_token");
      signalTokens.add("sheet_id");
    }
    if (pathname.includes("/calendar/")) {
      bumpDomainScore(domainBoosts, "calendar", 8);
      signalTokens.add("calendar_id");
      signalTokens.add("event_id");
    }
    if (pathname.includes("/task/") || pathname.includes("/todo/")) {
      bumpDomainScore(domainBoosts, "tasks", 8);
      signalTokens.add("task_guid");
      signalTokens.add("task_id");
      signalTokens.add("tasklist_guid");
    }
    if (pathname.includes("/message/") || pathname.includes("/im/")) {
      bumpDomainScore(domainBoosts, "messenger", 6);
      signalTokens.add("message_id");
    }

    for (const [key] of parsed.searchParams.entries()) {
      const normalized = key.trim().toLowerCase();
      if (PARAM_HINT_KEYS.includes(normalized)) {
        signalTokens.add(normalized);
      }
    }
  }

  return {
    links,
    domainBoosts,
    signalTokens,
  };
}

function toolDomain(tool: Tool): string {
  const segments = tool.name.split(".");
  const first = segments[0];
  if (first && first.length > 0) {
    return first;
  }
  return "general";
}

function requiredFields(tool: Tool): string[] {
  const required = tool.inputSchema.required;
  if (!Array.isArray(required)) {
    return [];
  }
  const parsed: string[] = [];
  for (const item of required) {
    if (typeof item === "string" && item.length > 0) {
      parsed.push(item);
    }
  }
  return parsed;
}

function extractRecentToolNames(messages: ChatMessage[]): string[] {
  const names: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls) {
      if (typeof call?.name === "string" && call.name.length > 0) {
        names.push(call.name);
      }
    }
    if (names.length >= 8) {
      break;
    }
  }
  return names;
}

function matchesRequiredField(queryTokens: Set<string>, field: string): boolean {
  const direct = field.toLowerCase();
  if (queryTokens.has(direct)) {
    return true;
  }

  const parts = direct
    .split(/[_-]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
  for (const part of parts) {
    if (queryTokens.has(part)) {
      return true;
    }
  }

  return false;
}

function normalizeDomainKeywords(
  tools: Tool[],
  options: Record<string, unknown> | undefined,
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const tool of tools) {
    const domain = toolDomain(tool);
    const defaults = DEFAULT_DOMAIN_HINTS[domain] ?? [];
    result.set(domain, [domain, ...defaults]);
  }

  if (!options) {
    return result;
  }

  for (const [domain, value] of Object.entries(options)) {
    const normalizedDomain = domain.trim().toLowerCase();
    if (normalizedDomain.length === 0) {
      continue;
    }
    const keywords = normalizeStringArray(value).map((item) => item.toLowerCase());
    if (keywords.length === 0) {
      if (!result.has(normalizedDomain)) {
        const defaults = DEFAULT_DOMAIN_HINTS[normalizedDomain] ?? [];
        result.set(normalizedDomain, [normalizedDomain, ...defaults]);
      }
      continue;
    }

    const defaults = result.get(normalizedDomain) ?? [normalizedDomain];
    const merged = new Set<string>([...defaults, ...keywords, normalizedDomain]);
    result.set(normalizedDomain, [...merged]);
  }

  return result;
}

function looksLikeWriteTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return WRITE_ACTION_HINTS.some((hint) => normalized.includes(hint));
}

export class HybridToolSelector implements ToolSelector {
  private readonly enabled: boolean;
  private readonly topK: number;
  private readonly perDomainK: number;
  private readonly allowTools: Set<string>;
  private readonly denyTools: Set<string>;
  private readonly readonlyMode: boolean;
  private readonly riskyWriteTools: Set<string>;
  private readonly alwaysIncludeTools: Set<string>;
  private readonly singleToolName: string | null;
  private readonly singleToolAfterIteration: number | null;
  private readonly domainHintsRaw?: Record<string, unknown>;

  public constructor(options: HybridSelectorOptions = {}) {
    this.enabled = normalizeBool(options.enabled, true);
    this.topK = normalizePositiveInteger(options.top_k, 16);
    this.perDomainK = normalizePositiveInteger(options.per_domain_k, 6);
    this.allowTools = new Set(normalizeStringArray(options.allow_tools));
    this.denyTools = new Set(normalizeStringArray(options.deny_tools));
    this.readonlyMode = normalizeBool(options.readonly_mode, false);
    this.riskyWriteTools = new Set(normalizeStringArray(options.risky_write_tools));
    this.alwaysIncludeTools = new Set([
      "LoadSkill",
      ...normalizeStringArray(options.always_include_tools),
    ]);
    this.singleToolName = normalizeNonEmptyString(options.single_tool_name);
    this.singleToolAfterIteration = this.singleToolName
      ? normalizePositiveInteger(options.single_tool_after_iteration, 2)
      : null;

    if (options.domains && typeof options.domains === "object" && !Array.isArray(options.domains)) {
      this.domainHintsRaw = options.domains as Record<string, unknown>;
    }
  }

  public select(input: ToolSelectorInput): ToolSelectorResult {
    const allToolNames = input.tools.map((tool) => tool.name);

    if (
      this.singleToolName &&
      this.singleToolAfterIteration !== null &&
      input.iteration >= this.singleToolAfterIteration
    ) {
      if (allToolNames.includes(this.singleToolName)) {
        return {
          selectedToolNames: [this.singleToolName],
          trace: {
            mode: "hybrid",
            enabled: true,
            iteration: input.iteration,
            total_count: allToolNames.length,
            selected_count: 1,
            forced_single_tool: true,
            forced_tool_name: this.singleToolName,
            forced_after_iteration: this.singleToolAfterIteration,
            fallback_to_all: false,
          },
        };
      }

      return {
        selectedToolNames: allToolNames,
        trace: {
          mode: "hybrid",
          enabled: true,
          iteration: input.iteration,
          total_count: allToolNames.length,
          selected_count: allToolNames.length,
          forced_single_tool: true,
          forced_tool_name: this.singleToolName,
          forced_after_iteration: this.singleToolAfterIteration,
          fallback_to_all: true,
          reason: "forced tool is not available in current tool registry",
        },
      };
    }

    if (!this.enabled) {
      return {
        selectedToolNames: allToolNames,
        trace: {
          mode: "hybrid",
          enabled: false,
          selected_count: allToolNames.length,
          total_count: allToolNames.length,
          reason: "disabled",
        },
      };
    }

    const queryText = [input.query, ...input.messages.slice(-4).map((item) => item.content)].join(
      "\n",
    );
    const queryTextLower = queryText.toLowerCase();
    const queryTokensList = tokenize(queryText);
    const queryTokens = new Set(queryTokensList);
    const domainKeywords = normalizeDomainKeywords(input.tools, this.domainHintsRaw);
    const linkSignals = extractLinkSignals(queryText);

    const domainScores: Array<{ domain: string; score: number }> = [];
    for (const [domain, keywords] of domainKeywords.entries()) {
      let score = 0;
      for (const keyword of keywords) {
        if (queryTextLower.includes(keyword)) {
          score += 2;
        }
        if (queryTokens.has(keyword)) {
          score += 3;
        }
      }
      score += linkSignals.domainBoosts.get(domain) ?? 0;
      domainScores.push({ domain, score });
    }

    domainScores.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
    const domainRank = new Map<string, number>(
      domainScores.map((item, index) => [item.domain, index] as const),
    );

    const routedDomains =
      domainScores
        .filter((item) => item.score > 0)
        .map((item) => item.domain)
        .slice(0, 3) || [];
    const activeDomains = routedDomains.length > 0 ? new Set(routedDomains) : null;

    const initialCandidates =
      activeDomains === null
        ? [...input.tools]
        : input.tools.filter((tool) => activeDomains.has(toolDomain(tool)));

    const lexicalCorpus = input.tools.map(
      (tool) =>
        new Set(tokenize(`${tool.name} ${tool.description} ${requiredFields(tool).join(" ")}`)),
    );

    const tokenDocumentFrequency = new Map<string, number>();
    for (const tokens of lexicalCorpus) {
      for (const token of tokens) {
        tokenDocumentFrequency.set(token, (tokenDocumentFrequency.get(token) ?? 0) + 1);
      }
    }

    const recentTools = extractRecentToolNames(input.messages);
    const recentSet = new Set(recentTools);
    const recentDomains = new Set(recentTools.map((name) => name.split(".")[0] ?? "general"));

    const scored: ScoredTool[] = [];
    for (const tool of initialCandidates) {
      const domain = toolDomain(tool);
      const lexicalTokens = new Set(
        tokenize(`${tool.name} ${tool.description} ${requiredFields(tool).join(" ")}`),
      );

      let lexicalScore = 0;
      for (const token of queryTokens) {
        if (!lexicalTokens.has(token)) {
          continue;
        }
        const df = tokenDocumentFrequency.get(token) ?? 1;
        lexicalScore += 1 / (1 + Math.log(1 + df));
      }

      const required = requiredFields(tool);
      let paramScore = 0;
      if (required.length === 0) {
        paramScore += 0.2;
      } else {
        for (const field of required) {
          const fieldLower = field.toLowerCase();
          const hasFieldSignal =
            matchesRequiredField(queryTokens, field) ||
            queryTextLower.includes(fieldLower) ||
            linkSignals.signalTokens.has(fieldLower);
          paramScore += hasFieldSignal ? 0.6 : -0.2;
        }
      }

      let sessionScore = 0;
      if (recentSet.has(tool.name)) {
        sessionScore += 1.0;
      }
      if (recentDomains.has(domain)) {
        sessionScore += 0.4;
      }

      let domainSignalScore = 0;
      const rank = domainRank.get(domain);
      if (rank !== undefined && rank < 3) {
        domainSignalScore += 0.6 - rank * 0.2;
      }
      if ((linkSignals.domainBoosts.get(domain) ?? 0) > 0) {
        domainSignalScore += 1.2;
      }

      const score = lexicalScore + paramScore + sessionScore + domainSignalScore;
      scored.push({
        tool,
        domain,
        lexicalScore,
        paramScore,
        sessionScore,
        domainSignalScore,
        score,
      });
    }

    const filtered = scored.filter((item) => {
      const name = item.tool.name;
      if (this.denyTools.has(name)) {
        return false;
      }
      if (
        this.allowTools.size > 0 &&
        !this.allowTools.has(name) &&
        !this.alwaysIncludeTools.has(name)
      ) {
        return false;
      }
      if (this.readonlyMode) {
        if (this.riskyWriteTools.has(name) || looksLikeWriteTool(name)) {
          return false;
        }
      }
      return true;
    });

    filtered.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

    const selected: string[] = [];
    const seen = new Set<string>();
    const selectedDomainCount = new Map<string, number>();

    for (const toolName of this.alwaysIncludeTools) {
      if (!allToolNames.includes(toolName)) {
        continue;
      }
      selected.push(toolName);
      seen.add(toolName);
      const domain = toolName.split(".")[0] ?? "general";
      selectedDomainCount.set(domain, (selectedDomainCount.get(domain) ?? 0) + 1);
      if (selected.length >= this.topK) {
        break;
      }
    }

    for (const item of filtered) {
      if (selected.length >= this.topK) {
        break;
      }
      const name = item.tool.name;
      if (seen.has(name)) {
        continue;
      }
      const currentDomainCount = selectedDomainCount.get(item.domain) ?? 0;
      if (currentDomainCount >= this.perDomainK) {
        continue;
      }
      selected.push(name);
      seen.add(name);
      selectedDomainCount.set(item.domain, currentDomainCount + 1);
    }

    for (const item of filtered) {
      if (selected.length >= this.topK) {
        break;
      }
      const name = item.tool.name;
      if (seen.has(name)) {
        continue;
      }
      selected.push(name);
      seen.add(name);
    }

    const fallbackToAll = selected.length === 0;
    const finalSelection = fallbackToAll ? allToolNames : selected;

    return {
      selectedToolNames: finalSelection,
      trace: {
        mode: "hybrid",
        enabled: true,
        iteration: input.iteration,
        total_count: allToolNames.length,
        routed_domain_count: routedDomains.length,
        routed_domains: routedDomains,
        candidate_count: initialCandidates.length,
        filtered_count: filtered.length,
        selected_count: finalSelection.length,
        top_k: this.topK,
        per_domain_k: this.perDomainK,
        readonly_mode: this.readonlyMode,
        fallback_to_all: fallbackToAll,
        detected_link_count: linkSignals.links.length,
        link_signal_domains: [...linkSignals.domainBoosts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([domain]) => domain),
        top_candidates: filtered.slice(0, 5).map((item) => ({
          tool: item.tool.name,
          domain: item.domain,
          score: Number(item.score.toFixed(3)),
          lexical_score: Number(item.lexicalScore.toFixed(3)),
          param_score: Number(item.paramScore.toFixed(3)),
          session_score: Number(item.sessionScore.toFixed(3)),
          domain_signal_score: Number(item.domainSignalScore.toFixed(3)),
        })),
      },
    };
  }
}
