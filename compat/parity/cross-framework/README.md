# Cross-Framework Parity Bench

This bench compares Python baseline (`/Users/yuning/Frontiers/NexAU-latest`) and Node rewrite (`/Users/yuning/Frontiers/NexAU-NodeJS`) on:

1. Multi-round prompt assembly + tool-call extraction parity (including skill + multi-tool extended case).
2. Long-context multi-round automatic compaction parity (mock LLM, no real model inference).

## Data

- `datasets/scenarios.json`: scripted model responses for prompt/extended/long-context scenarios.
- `tools/*.tool.yaml`: shared tool schemas.
- `skills/refactor-checklist/SKILL.md`: local skill fixture.
- `files/project_notes.md`: local file fixture.

## Harness

- `python_harness.py`: runs Python baseline with scripted LLM client and middleware timing probe.
- `node_harness.mjs`: runs Node rewrite with scripted LLM client and event timing probe.
- `run_compare.py`: builds Node dist, runs both harnesses, compares outputs, and writes reports.

## Run

```bash
/Users/yuning/Frontiers/NexAU-latest/.venv/bin/python compat/parity/cross-framework/run_compare.py
```

Reports are written to `compat/parity/cross-framework/results/` as timestamped files and `latest.json`/`latest.md`.

## Gate mode

```bash
python3 compat/parity/cross-framework/run_compare.py --check
```

If baseline interpreter is not in the default path, set `NEXAU_BASELINE_PYTHON` or pass `--python-bin`.
