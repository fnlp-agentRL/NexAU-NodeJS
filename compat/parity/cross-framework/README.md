# Cross-Framework Parity Bench

This bench compares Python baseline (`/Users/yuning/Frontiers/NexAU-latest`) and Node rewrite (`/Users/yuning/Frontiers/NexAU-NodeJS`) on:

1. Multi-round prompt assembly + tool-call extraction parity (including skill + multi-tool extended case).
2. Long-context multi-round automatic compaction parity (mock LLM, no real model inference).
3. Alias tool parity (`Bash` / `Write` / `TodoWrite`) with strict name-order + arguments + final output checks.
4. Error-path parity (`error_toolcall`) for tool parameter validation handling.
5. Example asset parity (`examples/`) for structured files (`yaml/yml/json`) with semantic equality checks.

## Data

- `datasets/scenarios.json`: scripted model responses for prompt/extended/error/long-context scenarios.
- Includes `alias_toolcall` and `error_toolcall` scenarios.
- `tools/*.tool.yaml`: shared tool schemas.
- `skills/refactor-checklist/SKILL.md`: local skill fixture.
- `files/project_notes.md`: local file fixture.

## Harness

- `python_harness.py`: runs Python baseline with scripted LLM client and middleware timing probe.
- `node_harness.mjs`: runs Node rewrite with scripted LLM client and event timing probe.
- `run_compare.py`: builds Node dist, runs both harnesses, compares outputs, and writes reports.
  - Prompt scenarios are checked on:
    - prompt message payload equality
    - tool-call extraction equality (name order + tool_call_id + arguments)
    - final output equality
    - tool-message semantic normalization for known non-deterministic fields
      (for example bash duration/output temp-path fields)
  - Long-context scenario is checked on:
    - prompt message-count sequence equality
    - compaction count delta gate
    - final message-count delta gate
- `compare_assets.mjs`: compares baseline/node `examples/` files.
  - Gate checks:
    - no missing structured files in Node
    - no structured semantic diffs (`yaml/yml/json`)
  - Non-structured file diffs are reported but do not block by default.
  - Optional strict modes:
    - `--strict-unstructured`: all non-structured diffs block.
    - `--strict-unstructured-prefixes skills,docs`: only matching path prefixes block.
- `run_parity_suite.mjs`: unified wrapper for runtime parity + asset parity,
  with one combined JSON/Markdown report and one final gate result.
  - Includes runtime scenario table (`prompt/tool/output`) and asset category summary.

## Run

```bash
/Users/yuning/Frontiers/NexAU-latest/.venv/bin/python compat/parity/cross-framework/run_compare.py
```

By default reports are written to an auto-created temp directory (printed in stdout).
To persist reports under repository, pass `--output-dir compat/parity/cross-framework/results`.
The bundled scenarios avoid persistent-memory side effects so local parity runs do not modify repository files.

## Gate mode

```bash
python3 compat/parity/cross-framework/run_compare.py --check
```

If baseline interpreter is not in the default path, set `NEXAU_BASELINE_PYTHON` or pass `--python-bin`.

## Asset gate

```bash
node compat/parity/cross-framework/compare_assets.mjs --check
```

CI-safe mode (skip when baseline repo is unavailable):

```bash
pnpm parity:assets:check
```

Strict examples:

```bash
node compat/parity/cross-framework/compare_assets.mjs --check --strict-unstructured
node compat/parity/cross-framework/compare_assets.mjs --check --strict-unstructured-prefixes skills,docs
```

## Unified suite

```bash
pnpm parity:all
pnpm parity:all:check
pnpm parity:all:failures
pnpm parity:all:diagnose
pnpm parity:all:triage
```

`--failures-only` 会生成“失败优先”摘要（仅保留失败场景与关键差异）。

## CI 失败定位

1. 先跑失败优先报告：

```bash
pnpm parity:all:failures
```

2. 一键提取关键字段（无需 jq）：

```bash
pnpm parity:all:triage
```

3. 一键提取高亮和明细片段（jq-friendly JSON）：

```bash
pnpm parity:all:diagnose
```

4. 如果你已经有某次 suite 结果，也可以直接诊断该结果：

```bash
pnpm parity:all:diagnose -- --suite-json <latest_json_path>
```

5. 进一步钻取 runtime/asset 明细：

```bash
pnpm parity:all:diagnose | jq '.failure_highlights'
pnpm parity:all:diagnose | jq '.runtime.failed_details'
pnpm parity:all:diagnose | jq '.assets'
```
