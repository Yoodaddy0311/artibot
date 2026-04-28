# Autopilot Phase 1 — Adoption Plan

| Field | Value |
|---|---|
| Session | ap-20260428-094832 |
| Phase | 1 (PLAN) |
| Date | 2026-04-28 |
| Owner | planner agent |
| Inputs | PRD + 4 benchmark reports (phd-skills, colleague-skill, openai-agents-python, agent-skills) |
| Status | Approved for Phase 2 EXECUTE |

## 1. Synthesis

The four benchmarks define a clear evolution spine for Artibot v3.0.0. `openai-agents-python` (DNA-fit 84.5/100) is the first repo benchmarked above Artibot (82.5) and donates the load-bearing architectural primitives — guardrails, agent-as-tool, sessions, local tracing, sandbox manifests, and HITL run-state — that close the orchestration gap without violating DATA POLICY (we adopt patterns, never code). `agent-skills` (71/100) donates the skill-prose discipline (anti-rationalization tables, "when NOT to use", three-layer Skills/Personas/Commands clarity) plus two genuinely novel hooks (sdd-cache HTTP-304 revalidation, simplify-ignore content masking). `phd-skills` (57/100) and `colleague-skill` (56/100) score lower overall but each contribute one high-leverage idea: phd-skills donates the `type:prompt` declarative hook + UserPromptSubmit ambiguity guard + visual-output reminder; colleague-skill donates the 6-layer Persona schema + Correction-overlay + per-skill versioning. The spine: orchestration primitives (P0) → skill-prose hardening (P0) → persona depth (P1) → declarative hooks (P1) → observability (P1) → sandbox manifest (P2) → HITL run-state (P2) → docs/index polish (P3). All P0/P1 work is additive; existing DEV protocol, Agent Teams API, 52 hooks, ESM-only stance, `toFileUrl()` Korean-path workaround, and 5,183 tests remain untouched.

## 2. Adoption Decision Matrix

Gates per PRD §6.2: G-DNA (DEV/hooks/Teams/lifecycle preserved), G-DATA (no external HTTP/DB/telemetry), G-STACK (ESM, Node>=18, no Python), G-VALUE (>=1 measurable benefit), G-COST (<200 LOC net or LOC-neutral). PASS = "Y", FAIL = "N", N/A = "—". Verdict in {ADOPT, TRANSFORM, REJECT, DEFER}. Priority in {P0, P1, P2, P3}.

| ID | Candidate | Source repo | G-DNA | G-DATA | G-STACK | G-VALUE | G-COST | Verdict | Priority |
|---|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| AD-01 | Input/Output Guardrail with tripwire (skill + lib) | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P0 |
| AD-02 | Tool Input/Output Guardrail (per-tool registry) | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P0 |
| AD-03 | Agent-as-tool wrapper (`agentAsTool()`) | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P0 |
| AD-04 | Handoff history filter | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-05 | Session ABC interface | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-06 | Tracing span taxonomy + local NDJSON exporter | openai-agents-python | Y | Y | Y | Y | Y | TRANSFORM | P1 |
| AD-07 | RunHooks `on_handoff`, `on_llm_start`, `on_llm_end` | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-08 | Sandbox capability + manifest model | openai-agents-python | Y | Y | Y | Y | N | TRANSFORM | P2 |
| AD-09 | Manifest command allowlist for Bash gate | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P0 |
| AD-10 | Run state serialize/resume for HITL | openai-agents-python | Y | Y | Y | Y | N | TRANSFORM | P2 |
| AD-11 | Dynamic tool approval predicate | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-12 | LLM-as-Judge skill | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-13 | Orchestration patterns skill | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-14 | Streaming guardrails | openai-agents-python | Y | Y | Y | Y | Y | DEFER | P3 |
| AD-15 | `llms.txt` index generator | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P3 |
| AD-16 | Snapshot tests for hook stdout JSON | openai-agents-python | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-17 | BackendSpanExporter (HTTP to OpenAI) | openai-agents-python | — | N | Y | Y | — | REJECT | — |
| AD-18 | OpenAI Conversations Session backend | openai-agents-python | — | N | Y | — | — | REJECT | — |
| AD-19 | LiteLLM / any-llm provider modules | openai-agents-python | — | N | Y | — | — | REJECT | — |
| AD-20 | Realtime/voice agent stack | openai-agents-python | — | N | N | — | — | REJECT | — |
| AD-21 | Sandbox vendor extensions | openai-agents-python | Y | N | Y | Y | — | REJECT | — |
| AD-22 | Anti-rationalization table pattern (top 20 skills) | agent-skills | Y | Y | Y | Y | Y | ADOPT | P0 |
| AD-23 | `using-agent-skills` meta-skill auto-injection | agent-skills | Y | Y | Y | Y | Y | ADOPT | P0 |
| AD-24 | sdd-cache HTTP 304 revalidation (WebFetch, local-only) | agent-skills | Y | Y | Y | Y | Y | TRANSFORM | P1 |
| AD-25 | simplify-ignore hook | agent-skills | Y | Y | Y | Y | Y | TRANSFORM | P2 |
| AD-26 | "When NOT to use" frontmatter field + 102-skill backfill | agent-skills | Y | Y | Y | Y | Y | ADOPT | P0 |
| AD-27 | Three-tier boundary in spec template | agent-skills | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-28 | Code-reviewer Verdict + tier template | agent-skills | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-29 | Skill anatomy doc | agent-skills | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-30 | References directory (testing/security/perf/a11y) | agent-skills | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-31 | Multi-harness install docs | agent-skills | Y | Y | Y | N | — | REJECT | — |
| AD-32 | source-driven-development skill | agent-skills | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-33 | code-simplification skill | agent-skills | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-34 | AGENTS.md three-layer model | agent-skills | Y | Y | Y | Y | Y | ADOPT | P0 |
| AD-35 | Bash-only hook implementations | agent-skills | N | Y | N | — | — | REJECT | — |
| AD-36 | "personas cannot orchestrate" hard rule | agent-skills | N | — | — | — | — | REJECT | — |
| AD-37 | type:prompt declarative hooks (Stop, UserPromptSubmit) | phd-skills | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-38 | UserPromptSubmit ambiguity guard | phd-skills | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-39 | Agent-level `isolation:worktree`, `memory:project` | phd-skills | Y | Y | Y | Y | Y | DEFER | P3 |
| AD-40 | PreCompact state-save (git branch + status) | phd-skills | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-41 | Visual-output forced-inspect hook | phd-skills | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-42 | 5-parallel-sub-agent audit pattern | phd-skills | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-43 | Real-incident → guardrail mapping table | phd-skills | Y | Y | Y | Y | Y | ADOPT | P3 |
| AD-44 | `/help` runtime self-discovery command | phd-skills | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-45 | AskUserQuestion `/onboard` wizard | phd-skills | Y | Y | Y | Y | Y | DEFER | P3 |
| AD-46 | Per-extension PreToolUse reminder routing | phd-skills | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-47 | notify.sh ntfy.sh / Slack webhooks | phd-skills | — | N | N | — | — | REJECT | — |
| AD-48 | factcheck/xray DBLP/arXiv WebFetch | phd-skills | — | N | Y | — | — | REJECT | — |
| AD-49 | Bash hooks (citation_guard/latex_check/save_state/notify) | phd-skills | — | Y | N | — | — | REJECT | — |
| AD-50 | 6-layer Persona schema | colleague-skill | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-51 | Tag-to-behavior translation table | colleague-skill | Y | Y | Y | Y | Y | ADOPT | P1 |
| AD-52 | Correction-layer overlay | colleague-skill | Y | Y | Y | Y | N | TRANSFORM | P2 |
| AD-53 | work.md + persona.md two-doc split | colleague-skill | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-54 | Per-skill versions/ archive + rollback | colleague-skill | Y | Y | Y | Y | N | TRANSFORM | P2 |
| AD-55 | 6-dimension code-author research dossier | colleague-skill | Y | Y | Y | Y | Y | DEFER | P3 |
| AD-56 | Diagnostic intake for vague intents | colleague-skill | Y | Y | Y | Y | Y | ADOPT | P2 |
| AD-57 | Bilingual KO/EN SKILL.md template | colleague-skill | Y | Y | Y | Y | Y | ADOPT | P3 |
| AD-58 | Feishu/DingTalk/Slack/WeChat collectors | colleague-skill | — | N | N | — | — | REJECT | — |
| AD-59 | Whisper transcribe_audio tool | colleague-skill | — | N | N | — | — | REJECT | — |
| AD-60 | Python requirements.txt | colleague-skill | — | — | N | — | — | REJECT | — |
| AD-61 | Multi-host installers (Hermes/OpenClaw/Codex) | colleague-skill | Y | Y | N | N | — | REJECT | — |
| AD-62 | Workplace-political tag entries | colleague-skill | N | Y | Y | N | — | REJECT | — |

Verdict tally: 33 ADOPT, 8 TRANSFORM, 16 REJECT, 5 DEFER. Phase 2 active P0+P1 scope: 22 items.

## 3. Dependency DAG

```
P0 FOUNDATIONS (independent, parallelizable)
  AD-01 Input/Output Guardrail ─┐
  AD-02 Tool Guardrail          ├─→ AD-04 Handoff filter (P1)
  AD-03 Agent-as-tool ──────────┤
  AD-09 Bash command allowlist  │
  AD-22 Anti-rationalization ───┼─→ AD-26 whenNotToUse field (P0, sibling) ─→ AD-29 Skill anatomy (P2)
  AD-23 Meta-skill auto-inject ─┤
  AD-34 AGENTS.md 3-layer ──────┘

P1 ORCHESTRATION + PROSE
  AD-01/02/03 ──→ AD-04 Handoff filter
  AD-05 Session ABC ───→ AD-06 Local NDJSON tracing ───→ AD-10 HITL run-state (P2)
  AD-05 Session ABC ───→ AD-25 simplify-ignore (P2)
  AD-07 RunHooks events ──→ AD-06 tracing
  AD-11 Tool approval predicate ─→ AD-10 HITL run-state (P2)
  AD-13 Orchestration patterns skill (depends on AD-03 + AD-04)
  AD-22 Anti-rationalization ──→ AD-27 3-tier boundary (spec-format)
  AD-22 ──→ AD-28 Code-reviewer verdict template
  AD-24 sdd-cache → AD-32 source-driven-development skill
  AD-37 type:prompt hooks ──→ AD-38 ambiguity guard (sibling, same hooks.json edit)
  AD-40 PreCompact state-save (independent)
  AD-50 6-layer Persona ──→ AD-51 tag-behavior table ──→ AD-52 Correction overlay (P2)
  AD-50 ──→ AD-53 work/persona split (P2)
```

Critical path: AD-23 → AD-22 → AD-26 → AD-29 → AD-30 → AD-33 (six steps, all skill-prose). Independent track: AD-01/02/03 → AD-04 → AD-05 → AD-06 → AD-10. Maximum parallelism: 4 squads.

## 4. File Allowlist

Phase 2 squads MUST NOT touch any path outside this list. Out-of-scope edits trigger automatic council reject.

### 4.1 Squad A — Orchestration Primitives (AD-01..AD-07, AD-09, AD-11, AD-13)

| Path | Action |
|---|---|
| `plugins/artibot/lib/orchestration/guardrails.js` | CREATE |
| `plugins/artibot/lib/orchestration/tool-guardrails.js` | CREATE |
| `plugins/artibot/lib/orchestration/agent-as-tool.js` | CREATE |
| `plugins/artibot/lib/orchestration/handoff-filter.js` | CREATE |
| `plugins/artibot/lib/observability/trace.js` | CREATE |
| `plugins/artibot/lib/observability/exporters/ndjson.js` | CREATE |
| `plugins/artibot/lib/learning/session.js` | CREATE |
| `plugins/artibot/lib/security/cmd-allowlist.js` | CREATE |
| `plugins/artibot/skills/guardrails/SKILL.md` | CREATE |
| `plugins/artibot/skills/orchestration-patterns/SKILL.md` | CREATE |
| `plugins/artibot/skills/tool-approval/SKILL.md` | CREATE |
| `plugins/artibot/scripts/hooks/on-handoff.js` | CREATE |
| `plugins/artibot/scripts/hooks/on-llm-start.js` | CREATE |
| `plugins/artibot/scripts/hooks/on-llm-end.js` | CREATE |
| `plugins/artibot/hooks/hooks.json` | MODIFY (register 3 new event names; allowlist gate) |
| `plugins/artibot/tests/lib/orchestration/guardrails.test.js` | CREATE |
| `plugins/artibot/tests/lib/orchestration/agent-as-tool.test.js` | CREATE |
| `plugins/artibot/tests/lib/observability/trace.test.js` | CREATE |
| `plugins/artibot/tests/lib/observability/no-egress.test.js` | CREATE (asserts no http/fetch in observability/) |
| `plugins/artibot/tests/lib/learning/session.test.js` | CREATE |

### 4.2 Squad B — Skill Prose Discipline (AD-22, AD-26, AD-27, AD-28, AD-34)

| Path | Action |
|---|---|
| `plugins/artibot/AGENTS.md` | MODIFY (three-layer model section) |
| `plugins/artibot/schemas/skill.schema.json` | MODIFY (add optional `whenNotToUse` field) |
| 20 SKILL.md files under `plugins/artibot/skills/` (spec-format, tdd-workflow, production-code-audit, code-slop-reviewer, systematic-debugging, verification-completion, quality-framework, coding-standards, security-standards, testing-standards, tool-design, prompt-engineering, delegation, multi-agent-patterns, memory-management, strategic-compact, fp-refactor, ddd-tactical-design, clarify, polish) | MODIFY (anti-rat + whenNotToUse) |
| `plugins/artibot/agents/code-reviewer.md` | MODIFY (Verdict + Critical/Important/Suggestion tiers) |
| `plugins/artibot/scripts/hooks/skill-validation-check.js` | MODIFY (warn on missing whenNotToUse) |
| `plugins/artibot/tests/skills/anti-rationalization.test.js` | CREATE |
| `plugins/artibot/tests/skills/when-not-to-use.test.js` | CREATE |

### 4.3 Squad C — Hooks & Caching (AD-23, AD-24, AD-37, AD-38, AD-40)

| Path | Action |
|---|---|
| `plugins/artibot/skills/using-agent-skills/SKILL.md` | CREATE (or rewrite if exists) |
| `plugins/artibot/scripts/hooks/skill-discovery-inject.js` | CREATE |
| `plugins/artibot/scripts/hooks/session-start.js` | MODIFY (call skill-discovery-inject on first daily session) |
| `plugins/artibot/scripts/hooks/webfetch-cache-pre.js` | CREATE |
| `plugins/artibot/scripts/hooks/webfetch-cache-post.js` | CREATE |
| `plugins/artibot/scripts/hooks/pre-compact.js` | MODIFY (write structured state file) |
| `plugins/artibot/scripts/hooks/ambiguity-guard.js` | CREATE |
| `plugins/artibot/hooks/hooks.json` | MODIFY (Stop/UserPromptSubmit type:prompt blocks; WebFetch hooks) |
| `plugins/artibot/docs/webfetch-cache.md` | CREATE |
| `plugins/artibot/tests/hooks/webfetch-cache.test.js` | CREATE |
| `plugins/artibot/tests/hooks/ambiguity-guard.test.js` | CREATE |
| `plugins/artibot/tests/hooks/pre-compact-state.test.js` | CREATE |
| `plugins/artibot/tests/hooks/skill-discovery-inject.test.js` | CREATE |
| `runtime/cache/webfetch/.gitkeep` | CREATE |
| `runtime/state/.gitkeep` | CREATE |
| `.gitignore` | MODIFY (ignore runtime/cache/, runtime/state/) |

### 4.4 Squad D — Persona Depth (AD-50, AD-51, AD-32)

| Path | Action |
|---|---|
| `plugins/artibot/skills/persona-distill/SKILL.md` | CREATE |
| `plugins/artibot/skills/persona-distill/references/six-layer-persona.md` | CREATE |
| `plugins/artibot/skills/persona-distill/references/tag-behavior-map.md` | CREATE |
| `plugins/artibot/skills/source-driven-development/SKILL.md` | CREATE |
| `plugins/artibot/skills/persona-architect/SKILL.md` | MODIFY (link 6-layer reference) |
| `plugins/artibot/lib/cognitive/router.js` | MODIFY (keyword list for source-driven, persona) |
| `plugins/artibot/tests/skills/persona-distill.test.js` | CREATE |
| `plugins/artibot/tests/skills/source-driven-development.test.js` | CREATE |

### 4.5 Cross-cutting (touched by ≥2 squads — coordinator-managed)

| Path | Owner |
|---|---|
| `plugins/artibot/hooks/hooks.json` | Squad A first (3 new event names), Squad C rebases |
| `plugins/artibot/scripts/hooks/session-start.js` | Squad C (sole modifier) |
| `docs/ARCHITECTURE.md` | Phase 6 doc-updater consolidates |

## 5. Squad Composition

| Squad | Name | Leader | Scope | Specialists | Expected Output |
|---|---|---|---|---|---|
| A | Orchestration Primitives | architect | AD-01..07, AD-09, AD-11, AD-13 | backend-developer, tdd-guide, security-reviewer | New `lib/orchestration/`, `lib/observability/`, `lib/learning/session.js`, `lib/security/cmd-allowlist.js`, 3 new skills, 3 new hook events; CI green; no-egress test |
| B | Skill Prose Discipline | doc-updater | AD-22, AD-26, AD-27, AD-28, AD-34 | typescript-pro, code-reviewer | 20 SKILL.md updated; AGENTS.md 3-layer; code-reviewer template; 2 tests |
| C | Hooks & Caching | backend-developer | AD-23, AD-24, AD-37, AD-38, AD-40 | tdd-guide, refactor-cleaner | 4 new ESM hooks; pre-compact extended; hooks.json + type:prompt; 4 tests; webfetch-cache.md |
| D | Persona Depth | llm-architect | AD-50, AD-51, AD-32 | doc-updater, planner | 2 new skills + 2 references; persona-architect updates; router keyword update; 2 tests |
| E | Verification & Council | code-reviewer | (cross-cuts all) | security-reviewer, e2e-runner | Cross-check + CI; sign off ledger |

## 6. Prune Backlog (Phase 5 only — NO deletes in Phase 1-4)

| ID | Source path in Artibot | Replacement | Justification |
|---|---|---|---|
| PR-01 | `skills/persona-architect/SKILL.md` (overlaps with persona-distill) | Merge with persona-distill | Redundancy after AD-50 |
| PR-02 | Skills with 0 invocations in 30d (audit `runtime/skill-injection-log/`) | None — delete | PRD §6.4 stale-prune rule |
| PR-03 | Duplicate prompt-cache skills if both exist | Single canonical via AD-24 | Behavioral redundancy after sdd-cache |
| PR-04 | Legacy command aliases >12 months old + 0 invocations | Single canonical per phase | v3.0.0 cleanup |
| PR-05 | Bash-style hook stragglers under `scripts/hooks/*` | ESM Node port | DNA: ESM-only |
| PR-06 | Documentation orphans under `docs/` (no inbound links) | Delete or redirect | PRD §6.4 |
| PR-07 | Agents not in `artibot.config.json` modelPolicy AND not Tasked in 30d | Consolidate | Drift |
| PR-08 | `runtime/benchmark/*.md` >60d with no follow-up adoption | Archive | Focus |
| PR-09 | Skills lacking `frontmatter.source_hash` post-codemod | Backfill | Phase 1 quick-wins follow-up |
| PR-10 | `*.test.js` skipped via `.skip` >30d | Re-enable or delete | DNA: tests must pass |
| PR-11 | `runtime/cache/` entries pre-AD-24 cache key format | Auto-delete on first sdd-cache run | Hash key change |
| PR-12 | `docs/PRD/` entries marked `Status: Superseded` >90d | Archive | Cleanliness |

Target: ≥ 8 deletions/merges in Phase 5.

## 7. Risk Update

| ID | Risk | Updated Likelihood | Mitigation |
|---|---|:---:|---|
| R1 | DNA regression | Low | Squad E gate; AD-01..07 all additive |
| R2 | DATA POLICY leak | Medium | new `tests/lib/observability/no-egress.test.js`; security-reviewer pass on AD-06, AD-24 |
| R3 | Test breakage | Medium | Phase 4 VERIFY; coverage thresholds enforced |
| R4 | Token budget overrun | Medium | checkpoints every 30m; 85% abort |
| R5 | Scope creep | Low | File allowlist (§4) is hard boundary |
| R6 | Korean path regression | Low | Dynamic imports use `toFileUrl()` |
| R7 | Cross-check stalemate | Medium | 2-round limit |
| R8 | Benchmark reports late | Resolved | All 4 landed |
| R9 | Python-only patterns adopted as code | Low | All openai-agents-python items pattern-only or REJECT |
| R10 | Auto-PR merge of medium-risk change | Low | `autoPR.autoMerge: false` |
| R11 | Memory bloat | Low | 6 new skills, within `lazyLoading.maxConcurrent: 5` envelope |
| R12 | DNA override toggled mid-session | Low | Confirmed at session boot |
| R13 (new) | sdd-cache HEAD revalidation flagged as external egress | Medium | HEAD only, read-only metadata; documented; security signoff |
| R14 (new) | Anti-rationalization codemod produces inconsistent prose | Medium | Squad B leader = doc-updater; canonical template; 5-skill spot-check first |
| R15 (new) | hooks.json edited by 2 squads creates merge conflict | Medium | Sequencing: A first, C rebases |
| R16 (new) | New tests increase CI runtime | Medium | <5m unit-suite budget; profile long-running |
| R17 (new) | persona-distill confused with persona-architect | Medium | Document distinction in AGENTS.md and both SKILL.md files |

## 8. Token Budget Plan

| Squad | Estimated Tokens |
|---|---:|
| A Orchestration | 380,000 |
| B Skill Prose | 280,000 |
| C Hooks & Caching | 220,000 |
| D Persona Depth | 180,000 |
| E Council/Verify | 220,000 |
| Phase 5 IMPROVE | 80,000 |
| Phase 6 REPORT | 100,000 |
| **Total Phase 1-6 (this run)** | **1,460,000** |

Budget remaining at start of Phase 1: ~1,700,000. Estimated total 1.46M leaves ~240K headroom (~14%). Hard abort at 85% of 2M = 1.7M cumulative.

## 9. Phase 2 Kickoff Order

| Wave | Squads | Wall-clock | Cumulative tokens |
|---|---|---|---:|
| W1 (T+0m) | A, B, C | 0–60m | ~880K |
| W2 (T+45m) | D | 45–90m | ~1.06M |
| W3 (T+75m) | E (Phase 3) | 75–120m | ~1.28M |
| W4 (T+120m) | Phase 4 VERIFY | 120–145m | ~1.34M |
| W5 (T+145m) | Phase 5 IMPROVE | 145–165m | ~1.42M |
| W6 (T+165m) | Phase 6 REPORT | 165–190m | ~1.52M |

Total wall-clock: ~190 min (3.2h). Within 4h limit. ~480K headroom under 2M cap (24%). Drop AD-13 then AD-04 if any squad overruns by >20%.

## 10. Success Criteria

| Goal | Pass Condition |
|---|---|
| G1 Net new artifacts | ≥5 new artifacts merged (target: 6) |
| G2 Prune | ≥8 deletions/merges in Phase 5 |
| G3 DNA | DEV protocol files unchanged; hooks expanded by ≥6; Agent Teams API surface unchanged; `npm run ci` exit 0 |
| G4 DATA POLICY | `no-egress.test.js` passes; security-reviewer signs off AD-06, AD-24 |
| G5 Documentation | Phase 6 report enumerates all 62 ledger items with diff links |
