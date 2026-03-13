#!/usr/bin/env python3
"""Extract Phase 0 compatibility fixtures from the Python baseline repository."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

BASELINE_REPO = Path(os.environ.get("NEXAU_BASELINE_REPO", "/Users/yuning/Frontiers/NexAU-latest"))
TARGET_FIXTURE_DIR = Path(__file__).resolve().parent.parent / "compat" / "parity" / "fixtures"

EXAMPLES = [
    "examples/code_agent/code_agent.yaml",
    "examples/deep_research/deep_research_agent.yaml",
    "examples/nexau_building_team/leader_agent.yaml",
]

DEFAULT_ENV = {
    "LLM_MODEL": "nex-agi/nex-n1.1",
    "LLM_BASE_URL": "https://example.com/v1",
    "LLM_API_KEY": "test-llm-api-key",
    "LANGFUSE_PUBLIC_KEY": "test-langfuse-public",
    "LANGFUSE_SECRET_KEY": "test-langfuse-secret",
    "LANGFUSE_HOST": "https://langfuse.example",
    "SUMMARY_MODEL": "summary-test-model",
    "SUMMARY_BASE_URL": "https://summary.example/v1",
    "SUMMARY_API_KEY": "test-summary-api-key",
}


def normalize(value: Any) -> Any:
    """Convert Python objects to stable JSON values."""
    if isinstance(value, dict):
        return {str(k): normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if isinstance(value, tuple):
        return [normalize(v) for v in value]
    if isinstance(value, set):
        return sorted(normalize(v) for v in value)
    if isinstance(value, Path):
        return str(value)
    return value


def collect_fixture(example_path: str, baseline_commit: str) -> dict[str, Any]:
    from nexau.archs.main_sub.config.config import AgentConfig
    from nexau.archs.main_sub.config.schema import AgentConfigSchema

    config_path = BASELINE_REPO / example_path
    schema = AgentConfigSchema.from_yaml(str(config_path))
    agent = AgentConfig.from_yaml(config_path)

    resolved_system_prompt = normalize(agent.system_prompt)

    event_stream = [
        {
            "type": "config.parse.started",
            "payload": {
                "path": example_path,
            },
        },
        {
            "type": "config.schema.validated",
            "payload": {
                "name": schema.name,
                "tool_count": len(schema.tools),
                "skill_count": len(schema.skills),
                "sub_agent_config_count": len(schema.sub_agents or []),
            },
        },
        {
            "type": "config.finalized",
            "payload": {
                "name": agent.name,
                "tool_count": len(agent.tools),
                "skill_count": len(agent.skills),
                "sub_agent_count": len((agent.sub_agents or {}).keys()),
                "stop_tools": sorted(agent.stop_tools),
            },
        },
    ]

    return {
        "meta": {
            "baseline_repo": str(BASELINE_REPO),
            "baseline_commit": baseline_commit,
            "source_yaml": example_path,
        },
        "input": {
            "env": DEFAULT_ENV,
        },
        "output": {
            "schema": normalize(schema.model_dump(mode="python", by_alias=True, exclude_none=True)),
            "finalized_summary": {
                "name": agent.name,
                "tool_call_mode": agent.tool_call_mode,
                "max_context_tokens": agent.max_context_tokens,
                "max_iterations": agent.max_iterations,
                "stop_tools": sorted(agent.stop_tools),
                "resolved_system_prompt": resolved_system_prompt,
                "system_prompt_type": agent.system_prompt_type,
                "tools_count": len(agent.tools),
                "skills_count": len(agent.skills),
                "sub_agents": sorted((agent.sub_agents or {}).keys()),
                "tracers_count": len(agent.tracers),
                "has_middlewares": bool(agent.middlewares),
                "llm_config": {
                    "model": agent.llm_config.model,
                    "base_url": agent.llm_config.base_url,
                    "api_type": agent.llm_config.api_type,
                    "stream": agent.llm_config.stream,
                    "max_tokens": agent.llm_config.max_tokens,
                    "temperature": agent.llm_config.temperature,
                    "extra_params": normalize(agent.llm_config.extra_params),
                },
            },
            "event_stream": event_stream,
        },
    }


def main() -> None:
    if not BASELINE_REPO.exists():
        raise SystemExit(f"Baseline repo does not exist: {BASELINE_REPO}")

    env = os.environ.copy()
    env.update(DEFAULT_ENV)
    os.environ.update(DEFAULT_ENV)

    baseline_commit = (
        subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=BASELINE_REPO, env=env, text=True).strip()
    )

    TARGET_FIXTURE_DIR.mkdir(parents=True, exist_ok=True)

    for example in EXAMPLES:
        fixture = collect_fixture(example, baseline_commit)
        output_name = f"{Path(example).stem}.fixture.json"
        output_path = TARGET_FIXTURE_DIR / output_name
        output_path.write_text(json.dumps(fixture, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
