# Artibot — Feature Matrix

Side-by-side comparison vs the most-cited orchestration frameworks. All marks
based on public documentation as of 2026-04-24; revisit before each submission.

## 1. Capability comparison

| Capability | Artibot | LangGraph | AutoGen | CrewAI |
|---|---|---|---|---|
| Native Claude Code integration | Yes (first-class) | No (BYO) | No (BYO) | No (BYO) |
| Parallel agent teams | Yes (TeamCreate API) | Manual graph | Yes (group chat) | Yes (sequential / hierarchical) |
| Auto-decomposition + cross-verify | Yes (operator-waits DNA) | Manual | Partial | Partial |
| Dual-process (System 1 / 2) routing | Yes (EFFORT_POLICY) | No | No | No |
| Lifelong learning (GRPO + drift) | Yes | No | No | No |
| Skill registry with frontmatter | Yes (100 skills) | No | No | Limited |
| MCP server integration | Yes (`.well-known/mcp-server.json`) | Plug-in | Plug-in | Plug-in |
| OTEL export (opt-in) | Yes | Manual | Manual | Manual |
| Multi-session dashboard | Yes (built-in) | No | No | No |
| Cross-tool export (Cursor / Codex / OpenCode) | Yes | No | No | No |
| Local-only data policy (enforced) | Yes (CRITICAL rule) | N/A | N/A | N/A |
| Test count | 4,918 | varies | varies | varies |
| Runtime dependencies | 0 | many | many | many |
| License | MIT | MIT | MIT | MIT |

## 2. Use-case fit

| Use case | Best fit |
|---|---|
| Production agent OS inside Claude Code | **Artibot** |
| Custom Python graph orchestration | LangGraph |
| Multi-LLM group chat experimentation | AutoGen |
| Role-play crews with sequential pipelines | CrewAI |

## 3. Where Artibot is unique

1. **Operator-waits DNA**: the orchestrator delegates by default; teammates execute and cross-check, no user keyword required.
2. **Data sovereignty as a hard rule**: no external DB, no third-party forwarding. Embedded in the runtime, not a config flag.
3. **Self-improvement is built-in, not a research demo**: GRPO + skill-evolver + drift-detector + skill-lifecycle-autopilot combined in production.
4. **Cross-tool reach**: AGENTS.md alias + export adapters mean the same agents work across Cursor / Codex CLI / OpenCode (subset).
5. **Zero runtime deps**: ESM, Node ≥ 20, no `node_modules` required at runtime.

## 4. Honest weaknesses

| Weakness | Notes |
|---|---|
| Community footprint | Smaller star count vs everything-cc (165k) and MetaGPT (46k). |
| Cross-tool parity | Only a subset of features lands outside Claude Code. |
| Public benchmarks | Self-benchmark exists; head-to-head benchmark vs LangGraph is roadmap. |

> Source: `_reports/market-competitive-eval-2026-04-24.md` Sections 4 & 6.
