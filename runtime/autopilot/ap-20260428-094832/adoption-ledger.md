# Adoption Ledger — ap-20260428-094832

| ID | Source Repo | Candidate (short) | Verdict | Priority | Owner squad | Target Artibot path | Acceptance evidence | Notes |
|---|---|---|---|:---:|:---:|---|---|---|
| AD-01 | openai-agents-python | Input/Output Guardrail with tripwire | ADOPT | P0 | A | `skills/guardrails/SKILL.md`, `lib/orchestration/guardrails.js` | guardrail trips on test fixture; throws `GuardrailTripped` | First-class safety primitive |
| AD-02 | openai-agents-python | Tool Input/Output Guardrail (per-tool) | ADOPT | P0 | A | `lib/orchestration/tool-guardrails.js` | Tool registry rejects bad input; behavior taxonomy honored | Pairs with AD-09 |
| AD-03 | openai-agents-python | Agent-as-tool wrapper | ADOPT | P0 | A | `lib/orchestration/agent-as-tool.js` | `agentAsTool()` returns sync result; integration test with stub | Lighter than TeamCreate |
| AD-04 | openai-agents-python | Handoff history filter | ADOPT | P1 | A | `lib/orchestration/handoff-filter.js` | Filter drops `function_call_output`/`reasoning`; payload smaller | Optional via `team.handoffFilter` |
| AD-05 | openai-agents-python | Session ABC interface | ADOPT | P1 | A | `lib/learning/session.js` | Default in-memory + JSON file backend; ABC methods covered | Foundation for AD-10 |
| AD-06 | openai-agents-python | Tracing span taxonomy + local NDJSON | TRANSFORM | P1 | A | `lib/observability/trace.js`, `lib/observability/exporters/ndjson.js` | NDJSON only to `runtime/traces/`; no-egress test passes | BackendSpanExporter REJECT |
| AD-07 | openai-agents-python | RunHooks `on_handoff`, `on_llm_*` | ADOPT | P1 | A | `scripts/hooks/on-handoff.js`, `on-llm-start.js`, `on-llm-end.js` | 3 new entries in `hooks.json`; existing 52 hooks unchanged | Additive |
| AD-08 | openai-agents-python | Sandbox capability + manifest | TRANSFORM | P2 | (defer) | `skills/sandbox-manifest/`, `lib/core/sandbox/` | Out of Phase 2 scope | High effort |
| AD-09 | openai-agents-python | Bash command allowlist | ADOPT | P0 | A | `lib/security/cmd-allowlist.js` | Default ls/find/stat/cat/grep/rg/head/tail/wc/cp/mkdir/rm | Hardens shell gate |
| AD-10 | openai-agents-python | Run state serialize/resume HITL | TRANSFORM | P2 | (defer) | `lib/orchestration/run-state.js` | Deferred | Depends on AD-05, AD-11 |
| AD-11 | openai-agents-python | Dynamic tool approval predicate | ADOPT | P1 | A | `skills/tool-approval/SKILL.md` | `needsApproval(ctx, params)` honored by PreToolUse | Pairs with AD-10 (P2) |
| AD-12 | openai-agents-python | LLM-as-Judge skill | ADOPT | P2 | (defer) | `skills/llm-judge/SKILL.md` | Out of Phase 2 scope | Extends adversarial-review |
| AD-13 | openai-agents-python | Orchestration patterns skill | ADOPT | P1 | A | `skills/orchestration-patterns/SKILL.md` | Documents deterministic/parallel/routing/handoff/agents-as-tools | Companion to AD-03/04 |
| AD-14 | openai-agents-python | Streaming guardrails | DEFER | P3 | — | — | Not in Phase 2 | Niche |
| AD-15 | openai-agents-python | `llms.txt` index | ADOPT | P3 | (defer) | `scripts/build/llms-index.js`, `runtime/llms.txt` | Deferred | Build-step only |
| AD-16 | openai-agents-python | Snapshot tests for hook stdout | ADOPT | P2 | (defer) | `lib/test/snapshot.js` | Deferred | Requires AD-06 fixtures |
| AD-17 | openai-agents-python | BackendSpanExporter (HTTP to OpenAI) | REJECT | — | — | — | n/a | DATA POLICY violation |
| AD-18 | openai-agents-python | OpenAI Conversations Session | REJECT | — | — | — | n/a | External coupling |
| AD-19 | openai-agents-python | LiteLLM / any-llm provider | REJECT | — | — | — | n/a | External HTTP egress |
| AD-20 | openai-agents-python | Realtime / voice agent stack | REJECT | — | — | — | n/a | OpenAI WebSocket dep |
| AD-21 | openai-agents-python | Sandbox vendor extensions | REJECT | — | — | — | n/a | Third-party cloud |
| AD-22 | agent-skills | Anti-rationalization tables (top 20 skills) | ADOPT | P0 | B | 20 SKILL.md files | Each has `## Common Rationalizations` + `## Red Flags` | Highest-leverage prose change |
| AD-23 | agent-skills | `using-agent-skills` meta-skill auto-injected | ADOPT | P0 | C | `skills/using-agent-skills/SKILL.md`, `scripts/hooks/skill-discovery-inject.js` | First daily session inject; `toFileUrl()` used | Lower cognitive friction |
| AD-24 | agent-skills | sdd-cache HTTP 304 (WebFetch local-only) | TRANSFORM | P1 | C | `scripts/hooks/webfetch-cache-pre.js`, `webfetch-cache-post.js` | Cache at `runtime/cache/webfetch/<sha>.json`; 304 returns body | R13 mitigated by docs |
| AD-25 | agent-skills | simplify-ignore | TRANSFORM | P2 | (defer) | `scripts/hooks/simplify-ignore.js`, `commands/code-simplify.md` | Deferred | Pairs with AD-33 |
| AD-26 | agent-skills | `whenNotToUse` field + 102-skill backfill | ADOPT | P0 | B | `schemas/skill.schema.json` + 102-skill backfill | Schema validates; lint warns then 0 | Backfill via codemod |
| AD-27 | agent-skills | 3-tier boundary (spec-format) | ADOPT | P1 | B | `skills/spec-format/SKILL.md` | EARS gains 3-tier table | Cleaner spec output |
| AD-28 | agent-skills | Code-reviewer Verdict + tier template | ADOPT | P1 | B | `agents/code-reviewer.md` | Verdict + Critical/Important/Suggestion tiers | Sharper output |
| AD-29 | agent-skills | Skill anatomy doc | ADOPT | P2 | (defer) | `docs/skill-anatomy.md` | Deferred | Companion to AD-26 |
| AD-30 | agent-skills | References dir (testing/security/perf/a11y) | ADOPT | P2 | (defer) | `references/` | Deferred | Light effort |
| AD-31 | agent-skills | Multi-harness install docs | REJECT | — | — | — | n/a | Out of Artibot scope |
| AD-32 | agent-skills | source-driven-development skill | ADOPT | P1 | D | `skills/source-driven-development/SKILL.md` | DETECT→FETCH→IMPLEMENT→CITE; auto-invoke on framework keywords | Pairs with AD-24 hook |
| AD-33 | agent-skills | code-simplification skill | ADOPT | P2 | (defer) | `skills/code-simplification/SKILL.md` | Deferred | Chesterton + Rule of 500 |
| AD-34 | agent-skills | AGENTS.md 3-layer model | ADOPT | P0 | B | `plugins/artibot/AGENTS.md` | Skills=how / Personas=who / Commands=when section | Foundational clarity |
| AD-35 | agent-skills | Bash-only hook implementations | REJECT | — | — | — | n/a | DNA: ESM-only |
| AD-36 | agent-skills | "personas cannot orchestrate" rule | REJECT | — | — | — | n/a | Conflicts with Agent Teams DNA |
| AD-37 | phd-skills | type:prompt declarative hooks (Stop, UserPromptSubmit) | ADOPT | P1 | C | `hooks/hooks.json` Stop block | DEV verify checklist gated declaratively | Zero runtime cost |
| AD-38 | phd-skills | UserPromptSubmit ambiguity guard | ADOPT | P1 | C | `hooks/hooks.json` + `scripts/hooks/ambiguity-guard.js` | Prompts <5 words trigger confirm | Defends "done"→"dont" typo |
| AD-39 | phd-skills | Agent-level `isolation:worktree`, `memory:project` | DEFER | P3 | — | — | Schema-support unknown | Probe Claude Code support first |
| AD-40 | phd-skills | PreCompact state-save | ADOPT | P1 | C | `scripts/hooks/pre-compact.js` (modify) | Writes `runtime/state/pre-compact-ISO.md` with cwd+branch+status | Per-project |
| AD-41 | phd-skills | Visual-output forced-inspect hook | ADOPT | P2 | (defer) | `scripts/hooks/visual-check.js` | Deferred | PostToolUse Bash matcher |
| AD-42 | phd-skills | 5-parallel-sub-agent audit pattern | ADOPT | P2 | (defer) | `skills/production-code-audit/` template | Deferred | Composes with Agent Teams |
| AD-43 | phd-skills | Real-incident → guardrail mapping table | ADOPT | P3 | (defer) | `docs/INCIDENTS.md` | Deferred | Pure docs |
| AD-44 | phd-skills | `/help` runtime self-discovery | ADOPT | P2 | (defer) | `commands/help.md` | Deferred | Reads `agents/`, `skills/`, `commands/` |
| AD-45 | phd-skills | AskUserQuestion `/onboard` wizard | DEFER | P3 | — | — | Not in Phase 2 | Future onboarding |
| AD-46 | phd-skills | Per-extension PreToolUse reminder | ADOPT | P2 | (defer) | `scripts/hooks/edit-guard.js` | Deferred | `.test.js`/`.sql` reminders |
| AD-47 | phd-skills | notify.sh ntfy.sh / Slack webhooks | REJECT | — | — | — | n/a | DATA POLICY |
| AD-48 | phd-skills | factcheck/xray DBLP/arXiv WebFetch | REJECT | — | — | — | n/a | Outbound query leak |
| AD-49 | phd-skills | Bash hooks (citation_guard etc) | REJECT | — | — | — | n/a | Bash-only Windows-incompatible |
| AD-50 | colleague-skill | 6-layer Persona schema | ADOPT | P1 | D | `skills/persona-distill/SKILL.md`, `references/six-layer-persona.md` | Layer 0–5 documented; new skill loads | Genuinely novel |
| AD-51 | colleague-skill | Tag-to-behavior translation | ADOPT | P1 | D | `references/tag-behavior-map.md` | Artibot-flavored tags (dev-strict, tdd-first, ko-path-aware, zero-dep, refactor-first, swarm-coordinator); workplace-political filtered | Composable tag layer |
| AD-52 | colleague-skill | Correction-layer overlay | TRANSFORM | P2 | (defer) | `lib/core/correction-overlay.js`, `bin/artibot-correct.js` | Deferred | Depends on AD-50 production |
| AD-53 | colleague-skill | work.md + persona.md split | ADOPT | P2 | (defer) | persona-* `work.md` siblings | Deferred | Optional; no breaking change |
| AD-54 | colleague-skill | versions/ archive + rollback | TRANSFORM | P2 | (defer) | `lib/core/skill-versioner.js`, `bin/artibot-skill-rollback.js` | Deferred | MAX_VERSIONS=10 |
| AD-55 | colleague-skill | 6-dimension code-author dossier | DEFER | P3 | — | — | Not in Phase 2 | Re-frame later |
| AD-56 | colleague-skill | Diagnostic intake for vague intents | ADOPT | P2 | (defer) | `skills/persona-distill/` intake | Deferred | "You haven't named a person" |
| AD-57 | colleague-skill | Bilingual KO/EN SKILL.md template | ADOPT | P3 | (defer) | `skills/_template/SKILL.md` | Deferred | KO-primary user benefit |
| AD-58 | colleague-skill | Feishu/DingTalk/Slack/WeChat collectors | REJECT | — | — | — | n/a | DATA POLICY hard violation |
| AD-59 | colleague-skill | Whisper transcribe_audio | REJECT | — | — | — | n/a | External API + ML deps |
| AD-60 | colleague-skill | Python requirements.txt | REJECT | — | — | — | n/a | DNA: ESM Node-only |
| AD-61 | colleague-skill | Multi-host installers | REJECT | — | — | — | n/a | Out of scope |
| AD-62 | colleague-skill | Workplace-political tag entries | REJECT | — | — | — | n/a | Anti-pattern enabler |

Total rows: 62. Verdict tally: 33 ADOPT, 8 TRANSFORM, 16 REJECT, 5 DEFER. Phase 2 active scope (P0+P1, in-allowlist): 22 items across squads A-D. Deferred-to-follow-up: 19. Rejects: 16. Defers: 5.
