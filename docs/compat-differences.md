# NexAU Compatibility Differences (Python -> Node.js)

This document tracks known behavior differences between:

- Python baseline: `NexAU-latest@eeda8372b6bfec859e5ed6cc1cd39664d2eac4d4`
- Node rewrite: `NexAU-NodeJS`

## Verified-compatible areas

- Core config model: `AgentConfig`, `LLMConfig`, YAML loading, env templating.
- Tool contract: `Tool.fromYaml`, schema validation, unified error shape.
- Executor loop: LLM -> tool -> LLM, `stop_tools`, retry/timeout, context compaction, sub-agent closure.
- Transports: chat CLI, HTTP (`/query`, `/stream`, `/health`, `/info`), STDIO json-lines.
- Sessions: persistent sqlite store with `user_id + session_id + agent_id` isolation.
- Extensibility: middleware pipeline, tracer interface with Langfuse adapter, MCP tool discovery/call (HTTP + stdio).
- Cross-framework scripted parity bench:
  - Prompt payload parity (multi-round + extended skill/tool chain): pass.
  - Tool-call extraction parity (multi-round + extended skill/tool chain): pass.
  - Long-context compaction parity (event count + final message count): pass.

## Cross-framework gate

Cross-framework parity gate command:

```bash
python3 compat/parity/cross-framework/run_compare.py --check
```

CI runs a safe gate wrapper (`pnpm parity:cross:check`) that skips only when baseline Python interpreter is unavailable.

## Phase 7 regression coverage

- Core examples runnable in Node runtime (load + execute):
  - `examples/code_agent/code_agent.yaml`
  - `examples/deep_research/deep_research_agent.yaml`
  - `examples/nexau_building_team/leader_agent.yaml`
- Transport e2e coverage:
  - HTTP query/stream/health/info
  - STDIO query/stream
  - chat command mode tests
- Quality gates:
  - `format`, `lint`, `typecheck`, `test` all green
  - Coverage remains above 70%

## Known deltas (current)

1. Middleware/tracer dynamic import

- Known middleware/tracer identifiers are mapped to built-in implementations.
- Unknown imports are currently treated as pass-through/no-op for runtime compatibility.

2. Langfuse integration depth

- Current adapter sends stable ingestion payloads and contracts.
- It is not a full parity implementation of Python tracer span hierarchy/OTel behavior.

3. Agent identity for sessions (resolved)

- Session isolation key now uses a deterministic config fingerprint (`name#hash`) instead of plain `name`.
- Runtime keeps backward compatibility by reading legacy `name` key when hashed key is empty and migrating data forward.

## Intentional non-goals retained from rewrite policy

- No line-by-line source parity with Python internals.
- Behavior compatibility is prioritized over internal implementation parity.
