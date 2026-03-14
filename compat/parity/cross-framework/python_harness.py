#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

THIS_DIR = Path(__file__).resolve().parent
PYTHON_REPO = Path("/Users/yuning/Frontiers/NexAU-latest").resolve()
if str(PYTHON_REPO) not in sys.path:
    sys.path.insert(0, str(PYTHON_REPO))

from nexau import Agent, AgentConfig  # type: ignore  # noqa: E402
from nexau.archs.main_sub.execution.hooks import (  # type: ignore  # noqa: E402
    AfterToolHookInput,
    BeforeModelHookInput,
    BeforeToolHookInput,
    HookResult,
    Middleware,
)
from nexau.archs.main_sub.execution.middleware.context_compaction.middleware import (  # type: ignore  # noqa: E402
    ContextCompactionMiddleware,
)


def normalize_value(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [normalize_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): normalize_value(item) for key, item in value.items()}
    return str(value)


def normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, str):
            normalized_content = content
        else:
            normalized_content = json.dumps(normalize_value(content), ensure_ascii=False)

        normalized.append(
            {
                "role": str(msg.get("role", "")),
                "name": msg.get("name"),
                "tool_call_id": msg.get("tool_call_id"),
                "content": normalized_content,
            }
        )
    return normalized


class TimingMiddleware(Middleware):
    def __init__(self) -> None:
        self.before_model_records: list[dict[str, Any]] = []
        self.tool_started: list[dict[str, Any]] = []
        self.tool_completed: list[dict[str, Any]] = []
        self._current_iteration: int = 0
        self._tool_start_by_id: dict[str, float] = {}

    def before_model(self, hook_input: BeforeModelHookInput) -> HookResult:
        self._current_iteration = int(hook_input.current_iteration) + 1
        self.before_model_records.append(
            {
                "iteration": self._current_iteration,
                "ts_ms": time.perf_counter() * 1000.0,
                "message_count": len(hook_input.messages),
            }
        )
        return HookResult.no_changes()

    def before_tool(self, hook_input: BeforeToolHookInput) -> HookResult:
        ts_ms = time.perf_counter() * 1000.0
        tool_call_id = str(hook_input.tool_call_id)
        self._tool_start_by_id[tool_call_id] = ts_ms
        self.tool_started.append(
            {
                "iteration": self._current_iteration,
                "tool_name": str(hook_input.tool_name),
                "tool_call_id": tool_call_id,
                "arguments": normalize_value(hook_input.tool_input),
                "ts_ms": ts_ms,
            }
        )
        return HookResult.no_changes()

    def after_tool(self, hook_input: AfterToolHookInput) -> HookResult:
        ts_ms = time.perf_counter() * 1000.0
        tool_call_id = str(hook_input.tool_call_id)
        start_ms = self._tool_start_by_id.get(tool_call_id)
        self.tool_completed.append(
            {
                "iteration": self._current_iteration,
                "tool_name": str(hook_input.tool_name),
                "tool_call_id": tool_call_id,
                "ts_ms": ts_ms,
                "duration_ms": (ts_ms - start_ms) if start_ms is not None else None,
            }
        )
        return HookResult.no_changes()


class ScriptedChatCompletions:
    def __init__(self, owner: "ScriptedOpenAIClient") -> None:
        self.owner = owner

    def create(self, **kwargs: Any) -> Any:
        start = time.perf_counter() * 1000.0
        idx = self.owner.cursor
        if idx >= len(self.owner.responses):
            raise RuntimeError(f"No scripted LLM response for call index {idx}")

        messages = kwargs.get("messages") or []
        tools = kwargs.get("tools") or []

        record: dict[str, Any] = {
            "index": idx + 1,
            "started_ms": start,
            "messages": normalize_messages(messages),
            "tools": normalize_value(tools),
        }

        scripted = self.owner.responses[idx]
        self.owner.cursor += 1

        tool_calls: list[dict[str, Any]] = []
        for tool_call in scripted.get("tool_calls", []):
            tool_calls.append(
                {
                    "id": str(tool_call["id"]),
                    "type": "function",
                    "function": {
                        "name": str(tool_call["name"]),
                        "arguments": json.dumps(tool_call.get("arguments", {}), ensure_ascii=False),
                    },
                }
            )

        message = {
            "role": "assistant",
            "content": scripted.get("content", ""),
            "tool_calls": tool_calls if tool_calls else None,
        }

        finish_reason = "tool_calls" if tool_calls else "stop"
        end = time.perf_counter() * 1000.0
        record["ended_ms"] = end
        record["duration_ms"] = end - start
        self.owner.calls.append(record)

        usage = {
            "prompt_tokens": max(1, len(json.dumps(messages, ensure_ascii=False)) // 4),
            "completion_tokens": max(1, len(str(scripted.get("content", ""))) // 4 + 1),
        }
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]

        return SimpleNamespace(
            choices=[SimpleNamespace(message=message, finish_reason=finish_reason)],
            usage=usage,
        )


class ScriptedOpenAIClient:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.cursor = 0
        self.calls: list[dict[str, Any]] = []
        self.chat = SimpleNamespace(completions=ScriptedChatCompletions(self))


def sum_durations(items: list[dict[str, Any]]) -> float:
    total = 0.0
    for item in items:
        duration = item.get("duration_ms")
        if isinstance(duration, (int, float)):
            total += float(duration)
    return total


def build_timing(
    llm_calls: list[dict[str, Any]],
    middleware: TimingMiddleware,
    run_start_ms: float,
    run_end_ms: float,
) -> dict[str, Any]:
    llm_inference_ms = sum_durations(llm_calls)
    tool_execution_ms = sum_durations(middleware.tool_completed)
    total_ms = run_end_ms - run_start_ms

    prompt_assembly_ms = 0.0
    parse_to_dispatch_ms = 0.0

    iteration_starts: dict[int, float] = {1: run_start_ms}

    by_iteration_tool_completed: dict[int, list[dict[str, Any]]] = {}
    for record in middleware.tool_completed:
        iteration = int(record.get("iteration", 0))
        by_iteration_tool_completed.setdefault(iteration, []).append(record)

    by_iteration_tool_started: dict[int, list[dict[str, Any]]] = {}
    for record in middleware.tool_started:
        iteration = int(record.get("iteration", 0))
        by_iteration_tool_started.setdefault(iteration, []).append(record)

    for idx, call in enumerate(llm_calls, start=1):
        started_ms = float(call["started_ms"])
        ended_ms = float(call["ended_ms"])

        iteration_start = iteration_starts.get(idx, run_start_ms)
        prompt_assembly_ms += max(0.0, started_ms - iteration_start)

        next_iteration = idx + 1
        previous_tool_end = None
        if idx in by_iteration_tool_completed and by_iteration_tool_completed[idx]:
            previous_tool_end = max(float(item["ts_ms"]) for item in by_iteration_tool_completed[idx])
        iteration_starts[next_iteration] = previous_tool_end if previous_tool_end is not None else ended_ms

        first_tool_start = None
        if idx in by_iteration_tool_started and by_iteration_tool_started[idx]:
            first_tool_start = min(float(item["ts_ms"]) for item in by_iteration_tool_started[idx])
        if first_tool_start is not None:
            parse_to_dispatch_ms += max(0.0, first_tool_start - ended_ms)

    return {
        "total_ms": total_ms,
        "llm_inference_ms": llm_inference_ms,
        "tool_execution_ms": tool_execution_ms,
        "framework_overhead_ms": total_ms - llm_inference_ms - tool_execution_ms,
        "prompt_assembly_ms": prompt_assembly_ms,
        "parse_to_dispatch_ms": parse_to_dispatch_ms,
        "tool_execution_breakdown": middleware.tool_completed,
    }


def group_tool_calls_by_iteration(middleware: TimingMiddleware) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for record in middleware.tool_started:
        key = str(record.get("iteration", 0))
        grouped.setdefault(key, []).append(
            {
                "name": str(record.get("tool_name", "")),
                "tool_call_id": str(record.get("tool_call_id", "")),
                "arguments": normalize_value(record.get("arguments", {})),
            }
        )
    return grouped


def run_scenario(scenario_name: str) -> dict[str, Any]:
    scenarios = json.loads((THIS_DIR / "datasets/scenarios.json").read_text(encoding="utf-8"))
    scenario = scenarios.get(scenario_name)
    if not isinstance(scenario, dict):
        raise RuntimeError(f"Unknown scenario: {scenario_name}")

    if scenario_name == "long_context":
        config_name = "long_context_agent.yaml"
    elif scenario_name == "alias_toolcall":
        config_name = "alias_parity_agent.yaml"
    else:
        config_name = "prompt_parity_agent.yaml"
    config_path = THIS_DIR / "configs" / config_name

    config = AgentConfig.from_yaml(config_path=config_path)

    timing_middleware = TimingMiddleware()
    context_middleware: ContextCompactionMiddleware | None = None

    if scenario_name == "long_context":
        context_middleware = ContextCompactionMiddleware(
            max_context_tokens=int(scenario.get("max_context_tokens", 700)),
            auto_compact=True,
            emergency_compact_enabled=False,
            threshold=0.3,
            compaction_strategy="tool_result_compaction",
            keep_iterations=2,
            keep_user_rounds=0,
        )
        config.max_context_tokens = int(scenario.get("max_context_tokens", 700))
        config.max_iterations = int(scenario.get("max_iterations", 28))
        config.middlewares = [context_middleware, timing_middleware]
    else:
        config.middlewares = [timing_middleware]

    client = ScriptedOpenAIClient(list(scenario.get("responses", [])))
    agent = Agent(config=config, user_id="parity_user", session_id=f"parity_{scenario_name}")

    run_start_ms = time.perf_counter() * 1000.0
    result = agent.run(
        message=str(scenario["user_message"]),
        custom_llm_client_provider=lambda _agent_name: client,
    )
    run_end_ms = time.perf_counter() * 1000.0

    compaction_count = int(getattr(context_middleware, "_compact_count", 0)) if context_middleware else 0
    compaction_removed = (
        int(getattr(context_middleware, "_total_messages_removed", 0)) if context_middleware else 0
    )

    placeholder_text = "Tool call result has been compacted"
    placeholder_hits = 0
    for call in client.calls:
        for message in call.get("messages", []):
            if placeholder_text in str(message.get("content", "")):
                placeholder_hits += 1

    payload = {
        "framework": "python",
        "scenario": scenario_name,
        "user_message": scenario["user_message"],
        "prompt_inputs": client.calls,
        "tool_calls_by_iteration": group_tool_calls_by_iteration(timing_middleware),
        "compaction": {
            "count": compaction_count,
            "removed_messages_total": compaction_removed,
            "prompt_message_counts": [len(call.get("messages", [])) for call in client.calls],
            "compacted_placeholder_hits": placeholder_hits,
            "final_message_count": len(agent.history),
        },
        "timing": build_timing(client.calls, timing_middleware, run_start_ms, run_end_ms),
        "result": {
            "output": result,
        },
    }
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--scenario",
        required=True,
        choices=[
            "prompt_toolcall",
            "prompt_toolcall_extended",
            "alias_toolcall",
            "error_toolcall",
            "long_context",
        ],
    )
    parser.add_argument("--output", default="")
    args = parser.parse_args()

    payload = run_scenario(args.scenario)
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
