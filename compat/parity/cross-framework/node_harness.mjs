#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { Agent, AgentConfig } from "../../../dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs(argv) {
  const args = {
    scenario: "prompt_toolcall",
    output: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--scenario") {
      args.scenario = argv[i + 1] ?? args.scenario;
      i += 1;
      continue;
    }
    if (token === "--output") {
      args.output = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
  }

  return args;
}

function normalizeValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = normalizeValue(item);
    }
    return next;
  }
  return String(value);
}

function normalizeMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    name: message.name ?? null,
    tool_call_id: message.tool_call_id ?? null,
    content:
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
  }));
}

function sumDurations(items) {
  return items.reduce((sum, item) => sum + (item.duration_ms ?? 0), 0);
}

class ScriptedLLMClient {
  constructor(responses) {
    this.responses = responses;
    this.cursor = 0;
    this.calls = [];
  }

  async complete(input) {
    const start = performance.now();
    const response = this.responses[this.cursor];
    if (!response) {
      throw new Error(`No scripted LLM response for call index ${this.cursor}`);
    }

    this.calls.push({
      index: this.cursor + 1,
      started_ms: start,
      messages: normalizeMessages(input.messages),
      tools: normalizeValue(input.tools),
    });

    this.cursor += 1;

    const end = performance.now();
    const call = this.calls[this.calls.length - 1];
    call.ended_ms = end;
    call.duration_ms = end - start;

    return {
      content: response.content ?? "",
      tool_calls: (response.tool_calls ?? []).map((callItem) => ({
        id: String(callItem.id),
        name: String(callItem.name),
        arguments: normalizeValue(callItem.arguments ?? {}),
      })),
    };
  }
}

function buildTiming(events, llmCalls, runStartMs, runEndMs) {
  const eventsByType = new Map();
  for (const event of events) {
    const list = eventsByType.get(event.type) ?? [];
    list.push(event);
    eventsByType.set(event.type, list);
  }

  const llmRequested = eventsByType.get("llm.requested") ?? [];
  const llmResponded = eventsByType.get("llm.responded") ?? [];
  const toolCalled = eventsByType.get("tool.called") ?? [];
  const toolCompleted = eventsByType.get("tool.completed") ?? [];

  const llmInferenceMs = sumDurations(llmCalls);

  const toolStartById = new Map();
  const toolExecDurations = [];

  for (const event of toolCalled) {
    toolStartById.set(String(event.payload.tool_call_id), event.ts_ms);
  }
  for (const event of toolCompleted) {
    const key = String(event.payload.tool_call_id);
    const start = toolStartById.get(key);
    if (start !== undefined) {
      toolExecDurations.push({
        tool_call_id: key,
        iteration: Number(event.payload.iteration ?? 0),
        duration_ms: event.ts_ms - start,
      });
    }
  }

  const toolExecutionMs = sumDurations(toolExecDurations);
  const totalMs = runEndMs - runStartMs;

  let promptAssemblyMs = 0;
  let parseToDispatchMs = 0;

  for (let i = 0; i < llmRequested.length; i += 1) {
    const request = llmRequested[i];
    const previousResponded = i > 0 ? llmResponded[i - 1] : null;
    const previousToolCompleted = toolCompleted
      .filter((event) => Number(event.payload.iteration ?? -1) === i)
      .sort((a, b) => a.ts_ms - b.ts_ms)
      .pop();

    const iterationStart = previousToolCompleted?.ts_ms ?? previousResponded?.ts_ms ?? runStartMs;
    promptAssemblyMs += Math.max(0, request.ts_ms - iterationStart);

    const firstToolCalled = toolCalled
      .filter((event) => Number(event.payload.iteration ?? -1) === i + 1)
      .sort((a, b) => a.ts_ms - b.ts_ms)[0];

    const llmEnd = llmCalls[i]?.ended_ms;
    if (firstToolCalled && llmEnd !== undefined) {
      parseToDispatchMs += Math.max(0, firstToolCalled.ts_ms - llmEnd);
    }
  }

  return {
    total_ms: totalMs,
    llm_inference_ms: llmInferenceMs,
    tool_execution_ms: toolExecutionMs,
    framework_overhead_ms: totalMs - llmInferenceMs - toolExecutionMs,
    prompt_assembly_ms: promptAssemblyMs,
    parse_to_dispatch_ms: parseToDispatchMs,
    tool_execution_breakdown: toolExecDurations,
  };
}

function groupToolCallsByIteration(events) {
  const result = {};
  for (const event of events) {
    if (event.type !== "tool.called") {
      continue;
    }
    const iteration = String(event.payload.iteration ?? "0");
    const list = result[iteration] ?? [];
    list.push({
      name: String(event.payload.tool_name ?? ""),
      tool_call_id: String(event.payload.tool_call_id ?? ""),
      arguments: normalizeValue(event.payload.tool_arguments ?? {}),
    });
    result[iteration] = list;
  }
  return result;
}

async function runScenario(args) {
  const scenariosPath = resolve(__dirname, "datasets/scenarios.json");
  const scenarios = JSON.parse(readFileSync(scenariosPath, "utf-8"));
  const scenario = scenarios[args.scenario];
  if (!scenario) {
    throw new Error(`Unknown scenario: ${args.scenario}`);
  }

  const configFile =
    args.scenario === "long_context"
      ? resolve(__dirname, "configs/long_context_agent.yaml")
      : args.scenario === "long_output_toolcall"
        ? resolve(__dirname, "configs/long_output_agent.yaml")
        : args.scenario === "alias_toolcall"
          ? resolve(__dirname, "configs/alias_parity_agent.yaml")
          : resolve(__dirname, "configs/prompt_parity_agent.yaml");

  const llm = new ScriptedLLMClient(scenario.responses ?? []);
  const config = AgentConfig.fromYaml(configFile, { env: process.env });
  const events = [];

  const agent = new Agent(config, {
    createLLMClient() {
      return llm;
    },
  });

  const runStartMs = performance.now();
  const result = await agent.run(scenario.user_message, {
    onEvent(event) {
      events.push({
        type: event.type,
        payload: normalizeValue(event.payload ?? {}),
        ts_ms: performance.now(),
      });
    },
  });
  const runEndMs = performance.now();

  const compactionEvents = events.filter((event) => event.type === "context.compacted");
  const timing = buildTiming(events, llm.calls, runStartMs, runEndMs);

  const payload = {
    framework: "node",
    scenario: args.scenario,
    user_message: scenario.user_message,
    prompt_inputs: llm.calls,
    tool_calls_by_iteration: groupToolCallsByIteration(events),
    compaction: {
      count: compactionEvents.length,
      dropped_total: compactionEvents.reduce(
        (sum, event) => sum + Number(event.payload.dropped_messages ?? 0),
        0,
      ),
      events: compactionEvents,
      prompt_message_counts: llm.calls.map((call) => call.messages.length),
      final_message_count: result.messages.length,
    },
    timing,
    result: {
      status: result.status,
      iterations: result.iterations,
      output: result.output,
      stop_tool_name: result.stop_tool_name ?? null,
      error: result.error ?? null,
    },
    raw_events: events,
  };

  const text = JSON.stringify(payload, null, 2);
  if (args.output) {
    writeFileSync(resolve(args.output), text, "utf-8");
  }

  process.stdout.write(text);
}

runScenario(parseArgs(process.argv)).catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
