# Cross-Framework Parity Report

- Generated at: 2026-03-14T02:18:01
- Frameworks: Python (NexAU-latest) vs Node (NexAU-NodeJS)

## 1) Prompt + Tool-Call Parity

| Scenario | Prompt payload equal | Tool-call extraction equal |
|---|---|---|
| prompt_toolcall | **True** | **True** |
| prompt_toolcall_extended | **True** | **True** |

### Component Timing (aggregated prompt scenarios, excluding LLM inference)

| Metric | Python (ms) | Node (ms) |
|---|---:|---:|
| total_ms | 19.380 | 4.261 |
| llm_inference_ms | 0.145 | 0.202 |
| tool_execution_ms | 10.905 | 2.974 |
| framework_overhead_ms | 8.330 | 1.086 |
| prompt_assembly_ms | 5.213 | 1.815 |
| parse_to_dispatch_ms | 3.615 | 0.309 |

## 2) Long Context Compaction Parity

- Prompt message-count sequence equal: **True**
- Python compaction count: **53**, Node compaction count: **53**
- Python final message count: **59**, Node final message count: **59**

## 3) Gate Result

- Overall parity passed: **True**
- Long-context compaction delta: **0** (allowed <= 0)