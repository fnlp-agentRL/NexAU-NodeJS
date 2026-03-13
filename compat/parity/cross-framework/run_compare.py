#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

THIS_DIR = Path(__file__).resolve().parent
REPO_ROOT = THIS_DIR.parent.parent.parent
DEFAULT_PYTHON_BIN = Path("/Users/yuning/Frontiers/NexAU-latest/.venv/bin/python")
NODE_BIN = "node"
DEFAULT_PROMPT_SCENARIOS = ["prompt_toolcall", "prompt_toolcall_extended"]
DEFAULT_LONG_SCENARIO = "long_context"


def run_json(cmd: list[str], cwd: Path) -> dict[str, Any]:
    proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(cmd)}\\nSTDOUT:\\n{proc.stdout}\\nSTDERR:\\n{proc.stderr}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Failed to parse JSON output for command: {' '.join(cmd)}\\nSTDOUT:\\n{proc.stdout}\\nSTDERR:\\n{proc.stderr}"
        ) from exc


def normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for msg in messages:
        normalized.append(
            {
                "role": msg.get("role"),
                "name": msg.get("name"),
                "tool_call_id": msg.get("tool_call_id"),
                "content": str(msg.get("content", "")),
            }
        )
    return normalized


def compare_prompt_inputs(
    python_prompts: list[dict[str, Any]],
    node_prompts: list[dict[str, Any]],
) -> dict[str, Any]:
    count = min(len(python_prompts), len(node_prompts))
    per_iteration: list[dict[str, Any]] = []
    all_equal = len(python_prompts) == len(node_prompts)

    for i in range(count):
        py_messages = normalize_messages(python_prompts[i].get("messages", []))
        nd_messages = normalize_messages(node_prompts[i].get("messages", []))
        same_messages = py_messages == nd_messages

        py_tools = python_prompts[i].get("tools", [])
        nd_tools = node_prompts[i].get("tools", [])
        same_tools = py_tools == nd_tools

        iteration_equal = same_messages and same_tools
        if not iteration_equal:
            all_equal = False

        per_iteration.append(
            {
                "iteration": i + 1,
                "same_messages": same_messages,
                "same_tools": same_tools,
                "python_message_count": len(py_messages),
                "node_message_count": len(nd_messages),
            }
        )

    return {
        "equal": all_equal,
        "python_calls": len(python_prompts),
        "node_calls": len(node_prompts),
        "per_iteration": per_iteration,
    }


def normalize_tool_calls_by_iteration(raw: dict[str, Any]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for key, value in raw.items():
        if not isinstance(value, list):
            continue
        names = []
        for item in value:
            if isinstance(item, dict):
                names.append(str(item.get("name", "")))
        out[str(key)] = sorted(names)
    return out


def compare_tool_calls(py: dict[str, Any], nd: dict[str, Any]) -> dict[str, Any]:
    py_norm = normalize_tool_calls_by_iteration(py)
    nd_norm = normalize_tool_calls_by_iteration(nd)
    iterations = sorted(set(py_norm) | set(nd_norm), key=lambda x: int(x))
    details = []
    equal = True

    for it in iterations:
        py_names = py_norm.get(it, [])
        nd_names = nd_norm.get(it, [])
        same = py_names == nd_names
        if not same:
            equal = False
        details.append(
            {
                "iteration": int(it),
                "python": py_names,
                "node": nd_names,
                "same": same,
            }
        )

    return {
        "equal": equal,
        "details": details,
    }


def resolve_python_bin(cli_value: str) -> Path:
    if cli_value:
        return Path(cli_value)
    env_value = os.environ.get("NEXAU_BASELINE_PYTHON", "").strip()
    if env_value:
        return Path(env_value)
    return DEFAULT_PYTHON_BIN


def parse_scenario_list(value: str) -> list[str]:
    items = [item.strip() for item in value.split(",")]
    return [item for item in items if item]


def aggregate_prompt_timing(cases: list[dict[str, Any]]) -> dict[str, Any]:
    metrics = [
        "total_ms",
        "llm_inference_ms",
        "tool_execution_ms",
        "framework_overhead_ms",
        "prompt_assembly_ms",
        "parse_to_dispatch_ms",
    ]

    aggregate: dict[str, dict[str, float]] = {
        "python": {metric: 0.0 for metric in metrics},
        "node": {metric: 0.0 for metric in metrics},
    }

    for case in cases:
        py_timing = case["python"].get("timing", {})
        nd_timing = case["node"].get("timing", {})
        for metric in metrics:
            aggregate["python"][metric] += float(py_timing.get(metric, 0.0))
            aggregate["node"][metric] += float(nd_timing.get(metric, 0.0))

    return {
        "scenario_count": len(cases),
        "python": aggregate["python"],
        "node": aggregate["node"],
    }


def build_markdown_report(results: dict[str, Any]) -> str:
    prompt_cases = results["prompt_cases"]
    long_ctx = results["long_context"]
    prompt_timing = results["overall"]["prompt_timing_aggregate"]

    lines: list[str] = []
    lines.append("# Cross-Framework Parity Report")
    lines.append("")
    lines.append(f"- Generated at: {results['generated_at']}")
    lines.append("- Frameworks: Python (NexAU-latest) vs Node (NexAU-NodeJS)")
    lines.append("")

    lines.append("## 1) Prompt + Tool-Call Parity")
    lines.append("")
    lines.append("| Scenario | Prompt payload equal | Tool-call extraction equal |")
    lines.append("|---|---|---|")
    for case in prompt_cases:
        lines.append(
            f"| {case['scenario']} | **{case['prompt_input_compare']['equal']}** | **{case['tool_call_compare']['equal']}** |"
        )
    lines.append("")

    lines.append("### Component Timing (aggregated prompt scenarios, excluding LLM inference)")
    lines.append("")
    lines.append("| Metric | Python (ms) | Node (ms) |")
    lines.append("|---|---:|---:|")
    lines.append(
        f"| total_ms | {prompt_timing['python']['total_ms']:.3f} | {prompt_timing['node']['total_ms']:.3f} |"
    )
    lines.append(
        f"| llm_inference_ms | {prompt_timing['python']['llm_inference_ms']:.3f} | {prompt_timing['node']['llm_inference_ms']:.3f} |"
    )
    lines.append(
        f"| tool_execution_ms | {prompt_timing['python']['tool_execution_ms']:.3f} | {prompt_timing['node']['tool_execution_ms']:.3f} |"
    )
    lines.append(
        f"| framework_overhead_ms | {prompt_timing['python']['framework_overhead_ms']:.3f} | {prompt_timing['node']['framework_overhead_ms']:.3f} |"
    )
    lines.append(
        f"| prompt_assembly_ms | {prompt_timing['python']['prompt_assembly_ms']:.3f} | {prompt_timing['node']['prompt_assembly_ms']:.3f} |"
    )
    lines.append(
        f"| parse_to_dispatch_ms | {prompt_timing['python']['parse_to_dispatch_ms']:.3f} | {prompt_timing['node']['parse_to_dispatch_ms']:.3f} |"
    )
    lines.append("")

    lines.append("## 2) Long Context Compaction Parity")
    lines.append("")
    lines.append(
        f"- Prompt message-count sequence equal: **{long_ctx['prompt_message_counts_equal']}**"
    )
    lines.append(
        f"- Python compaction count: **{long_ctx['python']['compaction']['count']}**, Node compaction count: **{long_ctx['node']['compaction']['count']}**"
    )
    lines.append(
        f"- Python final message count: **{long_ctx['python']['compaction']['final_message_count']}**, Node final message count: **{long_ctx['node']['compaction']['final_message_count']}**"
    )
    lines.append("")

    lines.append("## 3) Gate Result")
    lines.append("")
    lines.append(f"- Overall parity passed: **{results['overall']['passed']}**")
    lines.append(
        f"- Long-context compaction delta: **{results['overall']['long_context_compaction_delta']}** (allowed <= {results['config']['max_compaction_delta']})"
    )

    return "\n".join(lines)


def run_python_scenario(python_bin: Path, scenario: str) -> dict[str, Any]:
    return run_json(
        [
            str(python_bin),
            str(THIS_DIR / "python_harness.py"),
            "--scenario",
            scenario,
        ],
        cwd=REPO_ROOT,
    )


def run_node_scenario(scenario: str) -> dict[str, Any]:
    return run_json(
        [
            NODE_BIN,
            str(THIS_DIR / "node_harness.mjs"),
            "--scenario",
            scenario,
        ],
        cwd=REPO_ROOT,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        default=str(THIS_DIR / "results"),
        help="Directory for generated report artifacts",
    )
    parser.add_argument(
        "--python-bin",
        default="",
        help="Python interpreter for baseline NexAU repo (fallback env: NEXAU_BASELINE_PYTHON)",
    )
    parser.add_argument(
        "--prompt-scenarios",
        default=",".join(DEFAULT_PROMPT_SCENARIOS),
        help="Comma-separated prompt/tool-call scenarios to compare",
    )
    parser.add_argument(
        "--long-scenario",
        default=DEFAULT_LONG_SCENARIO,
        help="Long-context scenario name",
    )
    parser.add_argument(
        "--max-compaction-delta",
        type=int,
        default=0,
        help="Allowed absolute delta between Python and Node long-context compaction count",
    )
    parser.add_argument(
        "--skip-if-baseline-missing",
        action="store_true",
        help="Exit successfully when baseline Python interpreter does not exist",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit with non-zero code when any parity gate fails",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    python_bin = resolve_python_bin(args.python_bin)
    if not python_bin.exists():
        if args.skip_if_baseline_missing:
            print(
                json.dumps(
                    {
                        "skipped": True,
                        "reason": "baseline python interpreter not found",
                        "python_bin": str(python_bin),
                    },
                    ensure_ascii=False,
                )
            )
            return
        raise RuntimeError(
            f"Baseline python interpreter not found: {python_bin}. "
            "Set --python-bin or NEXAU_BASELINE_PYTHON, or pass --skip-if-baseline-missing."
        )

    prompt_scenarios = parse_scenario_list(args.prompt_scenarios)
    if not prompt_scenarios:
        raise RuntimeError("No prompt scenarios provided")

    subprocess.run(["pnpm", "build"], cwd=str(REPO_ROOT), check=True)

    prompt_cases: list[dict[str, Any]] = []
    for scenario in prompt_scenarios:
        python_payload = run_python_scenario(python_bin, scenario)
        node_payload = run_node_scenario(scenario)

        prompt_input_compare = compare_prompt_inputs(
            python_payload.get("prompt_inputs", []),
            node_payload.get("prompt_inputs", []),
        )
        tool_call_compare = compare_tool_calls(
            python_payload.get("tool_calls_by_iteration", {}),
            node_payload.get("tool_calls_by_iteration", {}),
        )

        prompt_cases.append(
            {
                "scenario": scenario,
                "python": python_payload,
                "node": node_payload,
                "prompt_input_compare": prompt_input_compare,
                "tool_call_compare": tool_call_compare,
                "passed": bool(prompt_input_compare["equal"] and tool_call_compare["equal"]),
            }
        )

    python_long = run_python_scenario(python_bin, args.long_scenario)
    node_long = run_node_scenario(args.long_scenario)

    long_prompt_counts_equal = (
        python_long.get("compaction", {}).get("prompt_message_counts", [])
        == node_long.get("compaction", {}).get("prompt_message_counts", [])
    )
    py_compaction_count = int(python_long.get("compaction", {}).get("count", 0))
    nd_compaction_count = int(node_long.get("compaction", {}).get("count", 0))
    long_compaction_delta = abs(py_compaction_count - nd_compaction_count)
    long_context_passed = long_prompt_counts_equal and long_compaction_delta <= args.max_compaction_delta

    prompt_passed = all(bool(case.get("passed")) for case in prompt_cases)
    overall_passed = bool(prompt_passed and long_context_passed)

    generated_at = datetime.now().isoformat(timespec="seconds")
    payload = {
        "generated_at": generated_at,
        "config": {
            "python_bin": str(python_bin),
            "prompt_scenarios": prompt_scenarios,
            "long_scenario": args.long_scenario,
            "max_compaction_delta": args.max_compaction_delta,
        },
        "prompt_cases": prompt_cases,
        # Backward-compatible alias for older tooling.
        "prompt_toolcall": prompt_cases[0] if prompt_cases else None,
        "long_context": {
            "python": python_long,
            "node": node_long,
            "prompt_message_counts_equal": long_prompt_counts_equal,
            "passed": long_context_passed,
        },
        "overall": {
            "prompt_passed": prompt_passed,
            "long_context_passed": long_context_passed,
            "long_context_compaction_delta": long_compaction_delta,
            "passed": overall_passed,
            "prompt_timing_aggregate": aggregate_prompt_timing(prompt_cases),
        },
    }

    report_md = build_markdown_report(payload)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = output_dir / f"cross-parity-{stamp}.json"
    md_path = output_dir / f"cross-parity-{stamp}.md"
    latest_json = output_dir / "latest.json"
    latest_md = output_dir / "latest.md"

    json_text = json.dumps(payload, ensure_ascii=False, indent=2)
    json_path.write_text(json_text, encoding="utf-8")
    md_path.write_text(report_md, encoding="utf-8")
    latest_json.write_text(json_text, encoding="utf-8")
    latest_md.write_text(report_md, encoding="utf-8")

    print(
        json.dumps(
            {
                "json_report": str(json_path),
                "markdown_report": str(md_path),
                "latest_json": str(latest_json),
                "latest_md": str(latest_md),
                "overall_passed": overall_passed,
            },
            ensure_ascii=False,
        )
    )

    if args.check and not overall_passed:
        raise RuntimeError(
            "Cross-framework parity gate failed: "
            f"prompt_passed={prompt_passed}, long_context_passed={long_context_passed}, "
            f"compaction_delta={long_compaction_delta}, allowed_delta={args.max_compaction_delta}"
        )


if __name__ == "__main__":
    main()
