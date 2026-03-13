# NexAU-NodeJS Integration Cases

This document shows how larger systems can integrate `NexAU-NodeJS` as an execution runtime.

## 1) Multi-Agent Software Delivery Platform

### Typical architecture

- Orchestrator service: decomposes goals into subtasks (plan, code, test, review).
- `NexAU-NodeJS` workers: each worker runs one `AgentConfig` with isolated session state.
- Tooling layer: file/shell/web/session/mcp builtins provide deterministic execution surface.
- Telemetry sink: tracer pipeline (including Langfuse adapter) collects run timelines.

### Why this project fits

- Stable execution loop: LLM -> tool -> LLM with retry/timeout/stop-tools.
- Session isolation: `user_id + session_id + agent_fingerprint` avoids cross-agent history bleed.
- Transport options: CLI/HTTP/STDIO make it easy to embed in schedulers, gateways, and local daemons.

### Minimal rollout path

1. Keep orchestrator as-is.
2. Replace per-agent Python runtime call with HTTP `/query` to `NexAU-NodeJS`.
3. Reuse existing YAML configs and tool schemas.
4. Run parity bench (`pnpm parity:cross:check`) for each critical flow before cutover.

## 2) Enterprise Deep-Research Pipeline

### Typical architecture

- API gateway receives research tasks.
- Retrieval and browser tooling exposed as builtins/MCP tools.
- A long-context agent performs iterative read/summarize/tool-calls.
- Reports are streamed to clients over SSE.

### Why this project fits

- Context compaction support for long multi-round runs.
- HTTP stream endpoint with stable event sequence.
- MCP integration for external research connectors.

### Implementation notes

- Use `max_context_tokens` + `context_compaction` middleware in YAML.
- Keep `tool_call_mode` explicit (`openai/xml/anthropic`) to avoid provider drift.
- Add protocol e2e tests (`*.e2e.test.ts`) for stream event contracts.

## 3) Cross-Channel Support Assistant (CLI + Gateway + Agent Runtime)

### Typical architecture

- Channel adapters (web/chatbot/IM) normalize user messages.
- Runtime service maps channel identity -> `user_id/session_id`.
- `NexAU-NodeJS` executes domain-specific agent configs.
- Session DB provides resumable conversations.

### Why this project fits

- Same runtime contract across CLI/HTTP/STDIO.
- Durable sqlite session store for restart recovery.
- Tool and schema validation reduce malformed-call failures in production.

### Operational checklist

1. Pin Node 22+ and pnpm lockfile in deployment images.
2. Use sqlite WAL mode (already enabled) for concurrent readers/writers.
3. Enable tracer adapter in non-dev environments for run diagnostics.
4. Add smoke tests for `/health`, `/info`, `/query`, `/stream`.

## 4) Agentic Build-and-Test Farm

### Typical architecture

- Job queue dispatches repo tasks to isolated workers.
- Each worker invokes `chat` CLI or STDIO server for deterministic scriptable runs.
- Tool calls use shell/file builtins for compile/test workflows.
- Final artifacts and logs are pushed back to CI storage.

### Why this project fits

- Strong tool loop behavior with explicit stop conditions.
- Easy embedding into existing CI runners using STDIO json-lines.
- Type-safe configs and tests reduce runtime surprises during scale-out.

### Recommended guardrails

- Restrict available tool set per job type.
- Set strict timeout/retry in `AgentConfig`.
- Keep regression packs for key workflows and run them in pre-merge CI.

## Example deployment profile

- Language runtime: Node.js 22+
- Package manager: pnpm
- API mode: HTTP + SSE
- Session backend: sqlite (single node) or external manager implementation (cluster)
- Observability: tracer pipeline + centralized logs
- Regression gate: `pnpm test` + `pnpm parity:cross:check`
