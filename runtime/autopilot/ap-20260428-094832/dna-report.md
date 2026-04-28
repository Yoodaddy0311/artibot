# DNA Cross-Check Report — Phase 3 Architecture Review

| Field | Value |
|---|---|
| Session | ap-20260428-094832 |
| Phase | 3 (CROSS_CHECK — DNA preservation) |
| Date | 2026-04-28 |
| Owner | architect agent |
| Verdict | **PRESERVED** |
| One-line | Phase 2 EXECUTE landed as a textbook additive layer extension — DNA invariants intact, layer ordering respected, DATA POLICY guarded by an executable test |

## DNA Checklist (D1–D9)

| Item | Verdict | Evidence |
|---|---|---|
| D1 DEV protocol | PASS | `plugins/artibot/CLAUDE.md:21-27,81-89` retains DECOMPOSE→EXECUTE→VERIFY twice. AGENTS.md additions confined to new §2.5 "Skills, Personas, Commands — How / Who / When" (lines 62-89); no contradictory workflow. The Stop hook's new `type:prompt` block at `hooks.json:372-381` REINFORCES the DEV verify checklist. |
| D2 Hook system | PASS (advisory) | `hooks/hooks.json` carries 59 `type:command` entries (52 legacy + 7 new) and 2 `type:prompt` blocks (Stop, UserPromptSubmit). 3 new event names registered: `on_handoff`/`on_llm_start`/`on_llm_end`. Dispatcher at `lib/core/hook-dispatcher.js:51-75` gracefully handles unknown event names. |
| D3 Agent Teams API | PASS | `agent-as-tool.js:33-56` is a pure builder — wraps an `agentSpec` into a `ToolSpec`. Does NOT call `TeamCreate`/`SendMessage`/`TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`. Surface untouched. |
| D4 Lifecycle phases | PASS | `lifecycle.json:1-62` unchanged. 8 phases intact. New `source-driven-development` skill is invoked via skill triggers; does NOT register a `default_agent`. ADDITIVE only. |
| D5 GRPO / Swarm / Lifelong | PASS | `lib/learning/grpo-optimizer.js` unmodified. `lib/swarm/*` (9 files) untouched. New `lib/learning/session.js` is sibling, not replacement. |
| D6 Prompt cache strategy | PASS | New `webfetch-cache-pre.js` / `post.js` operate on HTTP response bodies stored at `runtime/cache/webfetch/<sha1>.json` — distinct cache layer. Do NOT touch prompt-cache. |
| D7 ESM + Node>=18 + zero-dep | PASS | All 7 Squad-A lib files use `import` only. Zero `require(`/`module.exports` matches. `package.json` not modified. `toFileUrl()` confirmed at `scripts/utils/index.js:74-80`. |
| D8 Layer architecture | PASS | New files at correct layers; no upward imports detected. (See dedicated table below.) |
| D9 No silently skipped tests | PASS | Grep of `\.skip\(`/`\.todo\(` in new test dirs returned zero matches. |

## Layer Placement Audit

| New file | Declared layer | Imports from | Compliant |
|---|---|---|---|
| `lib/orchestration/guardrails.js` | Auxiliary (2) | none (pure) | YES |
| `lib/orchestration/tool-guardrails.js` | Auxiliary (2) | none (pure) | YES |
| `lib/orchestration/agent-as-tool.js` | Auxiliary (2) | none (pure) | YES |
| `lib/orchestration/handoff-filter.js` | Auxiliary (2) | none (pure) | YES |
| `lib/observability/trace.js` | Auxiliary (2) | `node:crypto` | YES |
| `lib/observability/exporters/ndjson.js` | Auxiliary (2) | `node:fs/promises`, `node:path` | YES |
| `lib/learning/session.js` | Learning (3) | `node:fs/promises`, `node:path` | YES (no upward import) |
| `lib/security/cmd-allowlist.js` | Auxiliary (2) | none (pure) | YES |
| `lib/cognitive/router.js` (modified) | Cognitive (4) | Core + sibling | YES (4→1 downward) |
| `scripts/hooks/on-{handoff,llm-start,llm-end}.js` | Hooks | `scripts/utils/index.js` | YES |
| `scripts/hooks/webfetch-cache-{pre,post}.js` | Hooks | utils + `lib/core/hook-utils.js` | YES |
| `scripts/hooks/ambiguity-guard.js` | Hooks | utils + `lib/core/hook-utils.js` | YES |

No upward imports detected. New files respect 5 → 4 → 3 → 2 → 1 ordering.

## DNA Invariant Table

| Invariant | Source of truth | Phase 2 impact | Verdict |
|---|---|---|---|
| DEV protocol (DECOMPOSE→EXECUTE→VERIFY) | `CLAUDE.md:5-9`, plugin CLAUDE.md:21-27,81-89 | Reinforced by Stop type:prompt block | PRESERVED |
| Zero-Skip Policy | `CLAUDE.md:10-13` | Untouched | PRESERVED |
| 5-Layer Architecture | plugin `CLAUDE.md:9-19` | New files placed correctly | PRESERVED |
| Agent Teams API surface | `AGENTS.md:18,30-35,137-138` | `agent-as-tool.js` is builder; does not invoke or shadow the 6 platform tools | PRESERVED |
| 8 lifecycle phases | `lifecycle.json:1-62` | File unchanged | PRESERVED |
| 52+ hooks (additive only) | `hooks/hooks.json` | Net +7 command hooks + 2 type:prompt + 3 new event names; legacy 52 intact | PRESERVED |
| Korean path workaround `toFileUrl()` | `scripts/utils/index.js:74-80` | Untouched | PRESERVED |
| ESM + Node>=18 + zero runtime deps | plugin CLAUDE.md:7, `package.json` | All new code ESM; node:* builtins only | PRESERVED |
| GRPO / swarm / lifelong learning | `lib/learning/grpo-*`, `lib/swarm/*` | No allowlist match; new session.js is sibling | PRESERVED |
| Prompt cache strategy | `skills/prompt-caching-strategy/` | Not in allowlist; webfetch-cache is distinct HTTP layer | PRESERVED |
| DATA POLICY | PRD §3 N2 | `tests/lib/observability/no-egress.test.js:71-112` actively guards Squad-A files | PRESERVED |
| AGENTS.md three-layer model | new §2.5 | Adds Skills/Personas/Commands; does NOT replace DEV protocol | PRESERVED |

## Findings (Advisories)

| ID | Severity | Item | Note |
|---|---|---|---|
| A1 | LOW | `lib/security/cmd-allowlist.js` not yet wired into `scripts/hooks/pre-bash.js` | Primitive landed; hook integration is implicit follow-up |
| A2 | LOW | `lib/observability/otel-exporter.js` (pre-existing, NOT in Phase 2 allowlist) imports `node:http` + `node:https` for opt-in OTLP export | `no-egress.test.js:25-34` correctly excludes via `OWNED_FILES` set; loopback enforcement at `otel-exporter.js:43,136-141` |
| A3 | INFO | Hook count: 59 `type:command` + 2 `type:prompt` = 61 hook bindings | "+7 command, +2 prompt, +3 new event-name slots" delta consistent with Squad A/C scope |

## Recommendations

| Priority | Item | Action |
|---|---|---|
| P2 | Wire `isAllowedCommand()` into `scripts/hooks/pre-bash.js` as soft warn | Single-line import + diagnostic message |
| P3 | Update `tests/lib/observability/no-egress.test.js` doc-comment to call out `otel-exporter.js` exemption | Pure documentation |
| P3 | Add cross-reference between AGENTS.md §2.5 and DEV protocol in plugin CLAUDE.md | One-line link insert |

## Sign-off

Phase 2 EXECUTE additions are **PRESERVED**-grade. Adoption respected the additive-only contract: 7 new lib modules, 6 new/modified hook scripts, 2 new skills, 1 router keyword extension, 1 hooks.json expansion, all routed through correct layers with zero downward replacements of DEV protocol, Agent Teams API, lifecycle phases, GRPO/swarm, prompt-cache, ESM stance, or `toFileUrl()` Korean-path workaround. Phase 3 CROSS_CHECK may proceed; Phase 4 VERIFY is unblocked from a DNA standpoint. Two low-priority follow-ups (cmd-allowlist wiring + otel exemption note) are non-blocking advisories.
