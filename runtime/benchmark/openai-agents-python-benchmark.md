# openai-agents-python Benchmark vs Artibot

| Field | Value |
|---|---|
| Target | openai-agents-python (https://github.com/openai/openai-agents-python) |
| Target version | tip-of-main (post v0.14, sandbox agents shipped) |
| Baseline | Artibot v3.0.0 plugin (`plugins/artibot/`) |
| Date | 2026-04-28 |
| Analyst | repo-benchmarker |
| Source path inspected | `/tmp/artibot-bench/openai-agents-python/` |
| Session | ap-20260428-094832 |

## 1. TL;DR

- OpenAI Agents SDK is the most architecturally mature multi-agent framework benchmarked so far: it ships first-class **handoffs, guardrails, sessions, tracing, sandbox agents, and HITL approvals** as cross-cutting primitives, all wired into a single `Runner` lifecycle.
- For Artibot it is a **pattern donor, not a code donor** — it is Python, OpenAI-API-coupled, and ships a hosted backend tracing exporter (which directly violates DATA POLICY). Direct integration is rejected; we lift only architectural shapes.
- Top adoptions: **input/output guardrail tripwire skill**, **agent-as-tool wrapper** for Agent Teams API, **session ABC** to formalize Artibot conversation history, **tracing span taxonomy** (local-only exporter), and **sandbox capability/manifest model** to harden Artibot's worktree execution.

## 2. Repository Overview

| Aspect | Detail |
|---|---|
| Purpose | Python SDK to build multi-agent LLM workflows over OpenAI Responses/Chat APIs and 100+ providers via LiteLLM. |
| Differentiator | Cleanest production-grade **multi-agent control plane**: agents-as-tools + handoffs + guardrails + sessions + tracing + sandbox agents + HITL — all composable. |
| Scale | 277 src `.py`, 210 example `.py`, 260 test `.py`, 375 doc `.md`, 70 sandbox examples. |
| Core primitives | `Agent`, `Runner`, `RunConfig`, `Session`, `Handoff`, `InputGuardrail`/`OutputGuardrail`, `ToolInputGuardrail`/`ToolOutputGuardrail`, `RunHooks`, `Tool` (incl. `agent.as_tool`), `Trace`/`Span`, `SandboxAgent`/`Manifest`/`Capability`. |
| Notable subsystems | `src/agents/sandbox/` (44 files: capabilities, manifests, sessions, snapshots, mounts), `src/agents/tracing/` (15 files), `src/agents/memory/` (sqlite, openai-conversations, compaction), `src/agents/realtime/` (16 files: voice). |
| Provider integrations | OpenAI Responses, Chat Completions, LiteLLM, any-llm, MCP (stdio/SSE/streamable-http), Realtime WebSocket, sandbox extensions for Modal / E2B / Daytona / Cloudflare / Vercel / Blaxel / Runloop. |
| Dev guidelines | `AGENTS.md` is authoritative; `CLAUDE.md` is single-line redirect. Mandatory skills: `$code-change-verification`, `$openai-knowledge`, `$implementation-strategy`, `$pr-draft-summary`. |

### 2.1 Scale comparison

| Metric | Artibot plugin | Agents SDK | Note |
|---|---:|---:|---|
| Skills / agent-pattern examples | 102 skills | 16 agent-pattern + 14 sandbox examples | Different unit; SDK ships patterns as runnable code |
| Agents (definitions) | 29 named agents | 0 prebuilt; SDK exposes `Agent` class | SDK is a framework |
| Commands / CLI surface | 57 slash commands | 1 REPL + Runner API | Artibot is end-user tool; SDK is library |
| Hooks | 52 hooks | RunHooks + AgentHooks (~8 events) | Comparable surface, different model |
| Lib JS / src files | 228 JS | 277 Py | Comparable code volume |
| Tests | (present) | 260 test files | SDK testing heavier |
| Docs | (present) | 375 md pages, multilingual (en/ja/ko) | SDK docs deeper |

## 3. 10-Dimension Scoring (DNA-Fit)

Scored as: **how well do the SDK's *patterns* translate into Artibot architecture?**

| # | Dimension | Weight | Artibot | Agents SDK | Δ | Winner | Justification |
|---|---|---:|---:|---:|---:|---|---|
| 1 | Agent Architecture | 15 | 8 | 9 | +1 | T | Artibot has 29 role-specialized agents + model policy; SDK adds `agent.as_tool()`, typed `output_type`, `handoff_description`, `RunContextWrapper[T]` generics. |
| 2 | Orchestration Patterns | 15 | 8 | 10 | +2 | T | SDK formalizes 4+ patterns side-by-side (deterministic, parallelization, routing/handoff, agents-as-tools, llm-as-judge, HITL with state save/resume). |
| 3 | Skill / Pattern Library | 10 | 9 | 7 | -2 | A | Artibot 102 frontmatter skills > SDK's 16 patterns. Per-pattern depth higher in SDK, but breadth wins. |
| 4 | Command System | 10 | 9 | 3 | -6 | A | SDK is a lib, no slash commands. Not a fair fight; SDK low on translatability. |
| 5 | Hook System | 10 | 9 | 7 | -2 | A | Artibot 52 lifecycle hooks > SDK's `RunHooks` (8 events). SDK's pattern is cleaner OO; Artibot's is more plug-points. |
| 6 | API / External Integration | 10 | 8 | 9 | +1 | T | SDK has MCP manager (stdio/SSE/streamable-http), 100+ LLM providers, tracing backend, 7 sandbox vendors. |
| 7 | Code Quality | 10 | 8 | 9 | +1 | T | SDK: type-strict (mypy + pyright in CI), `ruff`, `pytest`, snapshot tests, dataclasses + Protocol/ABC. |
| 8 | Documentation | 5 | 7 | 10 | +3 | T | 375 md pages, multilingual, `llms.txt`, mkdocs site. |
| 9 | CI / Validation | 5 | 8 | 9 | +1 | T | 9 GH workflows, parallel mypy+pyright, snapshot tests, ruff format-check. |
| 10 | Innovation | 10 | 8 | 10 | +2 | T | Tripwire guardrails, `agent.as_tool()`, `RunState.serialize()` for HITL, sandbox manifest+capability composition, structured handoff filters. |

### 3.1 Weighted total

| Repo | Weighted score |
|---|---:|
| Artibot | 82.5 / 100 |
| Agents SDK (DNA-fit) | 84.5 / 100 |
| Δ | **+2.0 in favor of SDK on translatable patterns** |

This is the first repo benchmarked above Artibot. Gap is concentrated in orchestration primitives (handoff/guardrail/HITL), tracing, and sandbox isolation — all adoptable as patterns.

## 4. Adoptable Architectural Patterns

All adoptions are **pattern translations** — Node.js / Artibot-internal — never direct code copy, never any HTTP egress to OpenAI.

| # | Pattern | OpenAI source path (reference only) | Artibot translation | Where it fits | Effort | Risk |
|---|---|---|---|---|---|---|
| 1 | Input/Output Guardrail with tripwire | `src/agents/guardrail.py` (`InputGuardrail`, `OutputGuardrail`, `GuardrailFunctionOutput.tripwire_triggered`) | New skill `plugins/artibot/skills/guardrails/` + lib `lib/orchestration/guardrails.js`. Guardrail = `{ name, run(ctx, input) → { tripped, info } }`. Run in parallel with main agent; on trip → halt + structured exception. Wire into Agent Teams API as `team.guardrails[]`. | Pre-flight checks for risky agents (security-reviewer, devops-engineer); output checks before file write. | M | L |
| 2 | Tool Input/Output Guardrail | `src/agents/tool_guardrails.py` (`ToolInputGuardrail`, `RejectContentBehavior`, `RaiseExceptionBehavior`) | Per-tool guardrail registry in `lib/orchestration/tool-guardrails.js`. Behaviors: `reject_content` (continue with refusal msg) vs `raise_exception` (abort). Hook into Bash/Write/Edit tool wrappers. | PreToolUse/PostToolUse hooks (extend with behavior taxonomy). | L | L |
| 3 | Agent-as-tool wrapper | `examples/agent_patterns/agents_as_tools.py`, `Agent.as_tool()` | `lib/orchestration/agent-as-tool.js`: wrap an Artibot agent so a parent agent can call it as a tool (synchronous result + summary back) instead of full TeamCreate. | Lightweight delegation when full team is overkill. | M | L |
| 4 | Handoffs with input filter | `src/agents/handoffs/__init__.py`, `src/agents/handoffs/history.py` | Extend Agent Teams API: when SendMessage delegates a task, allow `handoffFilter(history) → trimmed_history`. Mirror `_SUMMARY_ONLY_INPUT_TYPES` to drop `function_call`, `function_call_output`, `reasoning` on handoff. | `lib/orchestration/handoff-filter.js` consumed by SendMessage payload builder. | M | M |
| 5 | Session Protocol / ABC | `src/agents/memory/session.py` (`Session` Protocol + `SessionABC`) | Formalize `lib/learning/session.js` with `getItems(limit)`, `addItems(items)`, `popItem()`, `clearSession()`. Default: in-memory + JSON file. Optional: sqlite via `better-sqlite3`. | Backbone for `agent-memory-snapshot` skill and compaction recovery. | M | L |
| 6 | Tracing span taxonomy (local exporter only) | `src/agents/tracing/create.py` (`agent_span`, `function_span`, `handoff_span`, `guardrail_span`, `tool_span`, `task_span`, `turn_span`) | `lib/observability/trace.js` with span types. **Exporter = local NDJSON only** at `runtime/traces/`. **Refuse** `BackendSpanExporter`-style HTTP exporter (DATA POLICY). | Diagnostic-friendly run history. | M | M |
| 7 | RunHooks lifecycle | `src/agents/lifecycle.py` (`on_llm_start/end`, `on_agent_start/end`, `on_handoff`, `on_tool_start/end`) | Map to Artibot hook events; add `on_handoff` (Agent Teams transition) and `on_llm_start/end` as new optional hooks. Keep all 52 existing hooks. | Closes lifecycle gaps. | L | L |
| 8 | Sandbox capability + manifest model | `src/agents/sandbox/manifest.py`, `capabilities/capability.py`, `sandboxes/unix_local.py` | Promote worktree-based sandbox to `Manifest` (declarative entries: dirs, mounts, repos, env) + `Capability` plug-ins (filesystem, shell, memory, skills) that can `process_manifest`, expose tools, and append `instructions`. New skill `skills/sandbox-manifest/`. | Hardens devops-engineer + e2e-runner. | H | M |
| 9 | Manifest command allowlist | `src/agents/sandbox/manifest.py` (`DEFAULT_REMOTE_MOUNT_COMMAND_ALLOWLIST`) | Add allowlist to PreToolUse Bash gate. Export as `lib/security/cmd-allowlist.js` with same default list (ls, find, stat, cat, grep, rg, head, tail, wc, cp, mkdir, rm…). | Bash-validator hook + `code-slop-reviewer`. | L | L |
| 10 | Run state serialize / resume (HITL) | `examples/agent_patterns/human_in_the_loop.py` (`RunState.to_json()` / `from_json()` with approval interruptions) | `lib/orchestration/run-state.js`: serialize an in-flight team to disk on HITL pause; resume after approval. Persist under `runtime/teams/<id>/state.json`. | Approval flow for security-reviewer, devops, anything destructive. | H | M |
| 11 | Dynamic tool approval | `examples/agent_patterns/human_in_the_loop.py` (`@function_tool(needs_approval=fn)`) | Add `needsApproval(ctx, params)` predicate to tool registration in PreToolUse pipeline. Already partially exists — formalize as skill `skills/tool-approval/`. | Bash, Write, Edit, MCP gates. | L | L |
| 12 | LLM-as-Judge | `examples/agent_patterns/llm_as_a_judge.py` | Skill `skills/llm-judge/` describing 2-agent loop: drafter + judge (rubric scored). Adjacent to `adversarial-review` — extend it. | Code review, marketing copy review. | L | L |
| 13 | Deterministic / parallel / routing taxonomy | `examples/agent_patterns/{deterministic,parallelization,routing}.py` | Document explicitly in `skills/orchestration-patterns/`. Match Artibot's existing Team patterns. | Architect / planner agents reference this. | L | L |
| 14 | Streaming guardrails | `examples/agent_patterns/streaming_guardrails.py` | Output-while-streaming guardrail: chunk-level tripwire that halts mid-stream. `lib/orchestration/streaming-guardrails.js`. | Long-running streaming agents. | M | M |
| 15 | `AGENTS.md` redirect convention | `CLAUDE.md` → `AGENTS.md` | Already adopted from earlier benchmark. Adopt SDK's `AGENTS.md` structure (Policies & Mandatory Rules → Project Structure → Operation Guide). | Top-level repo guidance. | L | L |
| 16 | `llms.txt` / `llms-full.txt` index | `docs/llms.txt`, `docs/llms-full.txt` | Generate `runtime/llms.txt` from skill+agent frontmatter. Helps Claude/Codex enumerate Artibot capabilities. | Build step in `npm run release` chain. | L | L |
| 17 | Snapshot tests for agent IO | `tests/test_agent_*.py` snapshot fixtures | Adopt snapshot-style tests for hook stdout JSON. | `lib/test/` infrastructure. | M | L |
| 18 | Per-pattern runnable example READMEs | `examples/agent_patterns/README.md` | Each Artibot orchestration pattern gets a `README.md` + minimal runnable script under `examples/orchestration/`. | Onboarding, demo. | M | L |

## 5. Reject List

| Item | Why rejected |
|---|---|
| `BackendSpanExporter` (`tracing/processors.py`) sending traces to `https://api.openai.com/v1/traces/ingest` | Direct DATA POLICY violation. Adopt span taxonomy, NOT exporter. |
| OpenAI Responses API conversation tracking (`run_internal/oai_conversation.py`, `OpenAIConversationsSession`) | Couples conversation state to OpenAI servers. |
| LiteLLM / any-llm / OpenAI provider modules (`extensions/models/`) | External HTTP egress paths. |
| Hosted MCP variants that proxy through OpenAI | Only local + user-controlled MCP servers allowed. |
| Redis / MongoDB / SQLAlchemy / Dapr session backends (`extensions/memory/`) | External DBs forbidden. Only opt-in *in-process* sqlite via `better-sqlite3`. |
| Realtime / voice agent stack (`src/agents/realtime/`) | Out of scope; relies on OpenAI WS endpoint. |
| Sandbox vendor extensions (`extensions/sandbox/blaxel|cloudflare|daytona|e2b|modal|runloop|vercel`) | Third-party cloud sandboxes. Pattern adopted, vendors not. |
| Python-specific machinery (`pydantic`, `dataclass`, `Protocol`, `@input_guardrail` decorator) | Translate semantics to plain JS; do not add `zod`/`class-validator`. Artibot is zero-dep. |
| `graphviz` visualization (`extensions/visualization.py`) | Adds binary dep. Use Mermaid (already in stack). |
| `uv` + `pyproject.toml` build chain | Python tooling, irrelevant. |

## 6. Architecture Comparison — Agents SDK vs Artibot

| Concern | Agents SDK | Artibot | Translation gap |
|---|---|---|---|
| Agent definition | `Agent(name, instructions, tools, handoffs, output_type, input_guardrails, output_guardrails, model_settings)` dataclass | Frontmatter agent files in `agents/` + `Task()` invocation | Add typed output schema and guardrail arrays to agent frontmatter. |
| Multi-agent orchestration | `handoffs=[Agent(...)]` + `agent.as_tool()` + `Runner.run()` | Agent Teams API (`TeamCreate`, `SendMessage`, `TaskCreate/Update`) + `Task()` | Add `as_tool()` shim and handoff history filter. |
| Conversation history | `Session` Protocol; default `SQLiteSession`, plus `EncryptedSession`, `OpenAIConversationsSession`, `CompactionSession` | `compaction-survival` + `agent-memory-snapshot` skills | Formalize `Session` interface; sqlite local backend optional. |
| Guardrails | `InputGuardrail`/`OutputGuardrail` (parallel, tripwire) + `ToolInputGuardrail`/`ToolOutputGuardrail` | None as first-class concept; partial coverage in PreToolUse hooks + `code-slop-reviewer` | New skill + lib module. |
| Tracing | `Trace`/`Span` with 13 span types, processor interface, console+backend exporters | Telemetry events in hooks but no span tree | Span taxonomy, local-only NDJSON exporter. |
| HITL | Tool `needs_approval`, `RunState.to_json()` / resume, `ToolApprovalItem` | Approval-by-prompt only; no run-state serialization | Add run-state persistence under `runtime/teams/`. |
| Sandbox | `SandboxAgent` + `Manifest(entries=Dir, GitRepo, Mount)` + `Capabilities` (filesystem, shell, memory, skills) | Worktree-based isolation per agent | Promote to declarative manifest + capabilities. |
| Lifecycle hooks | `RunHooks`/`AgentHooks`: 8 events | 52 hooks across PreToolUse/PostToolUse/SessionStart/etc. | Add `on_handoff` and `on_llm_start/end`. |
| Tools | `@function_tool` decorator + 11 hosted tool types (web search, file search, code interpreter, image gen, MCP) | Bash, Write, Edit, Task, MCP — native Claude Code | No change; framework difference. |
| Streaming | `Runner.run_streamed()` + `RunResultStreaming` events | Statusline + token stream observation | Adopt streaming guardrail pattern. |
| Provider | OpenAI Responses + Chat + LiteLLM + Realtime | Claude Code only | Stay Claude Code only. |
| Docs | Mkdocs site, multilingual, `llms.txt` | README + skills/agents frontmatter | Generate `llms.txt` index. |
| Distribution | PyPI package | npm-style plugin folder | No change. |

## 7. Top 5 Concrete Actions

| # | Priority | Action | Concrete location | Effort | Why now |
|---|---|---|---|---:|---|
| 1 | HIGH | Add **input/output guardrail** primitive: skill + lib `lib/orchestration/guardrails.js`. Wire into Agent Teams API: `team.input_guardrails[]`, `team.output_guardrails[]`. Add `GuardrailTripped` exception. | `plugins/artibot/skills/guardrails/`, `plugins/artibot/lib/orchestration/guardrails.js` | M | Closes the largest single architectural gap; aligns with safety roadmap. |
| 2 | HIGH | Add **agent-as-tool** wrapper: `lib/orchestration/agent-as-tool.js` with `agentAsTool(agent, { name, description })` so a caller agent can invoke another agent synchronously without spinning up a full team. | `plugins/artibot/lib/orchestration/agent-as-tool.js`, doc in `skills/orchestration-patterns/` | M | Enables lightweight delegation that Artibot currently overpays for via TeamCreate. |
| 3 | HIGH | Formalize **Session interface** + local-only span tracing. New `lib/learning/session.js`; new `lib/observability/trace.js` with span taxonomy and **NDJSON exporter that writes only to `runtime/traces/`**. Add CI test asserting no http(s) egress. | `plugins/artibot/lib/learning/session.js`, `plugins/artibot/lib/observability/trace.js`, test in `lib/test/` | M | Foundation for HITL state-resume and observability without violating DATA POLICY. |
| 4 | MEDIUM | Promote sandbox/worktree to **declarative manifest + capability** model. New skill `skills/sandbox-manifest/`; new lib `lib/core/sandbox/manifest.js` + `capability.js`. Reuse default Bash allowlist (ls/find/stat/cat/grep/rg/…). Preserve `toFileUrl()` Korean path workaround in `utils/index.js`. | `plugins/artibot/skills/sandbox-manifest/`, `plugins/artibot/lib/core/sandbox/` | H | Hardens devops-engineer + e2e-runner; surfaces what each agent can touch. |
| 5 | MEDIUM | Add **HITL run-state serialize/resume** to Agent Teams. `lib/orchestration/run-state.js` with `serialize(team)` / `resume(JSON)`. Persist to `runtime/teams/<id>/state.json` on `pause-for-approval`. Pair with `tool-approval` skill that lets tool registrations declare `needsApproval(ctx, params) → bool`. | `plugins/artibot/lib/orchestration/run-state.js`, `plugins/artibot/skills/tool-approval/` | H | Unlocks safe destructive operations with explicit approval gates. |

### 7.1 Out-of-band quick wins

| Action | Path | Effort |
|---|---|---|
| Generate `runtime/llms.txt` index from skill+agent frontmatter on release | `plugins/artibot/scripts/build/llms-index.js` | L |
| Add `on_handoff`, `on_llm_start`, `on_llm_end` hook events | `plugins/artibot/scripts/hooks/` | L |
| `skills/orchestration-patterns/` documenting deterministic / parallel / routing / handoff / agents-as-tools / llm-as-judge mapped to Artibot | `plugins/artibot/skills/orchestration-patterns/SKILL.md` | L |
| Adopt SDK's `AGENTS.md` template structure | `AGENTS.md` (root) | L |

## 8. Workflow DNA Preservation Check

| Artibot DNA element | Impact | Status |
|---|---|---|
| DEV protocol (Decompose-Execute-Verify) | Guardrails and HITL run *around* DEV, not inside. | Preserved |
| Agent Teams API | Extended (handoff filter, agent-as-tool, run-state). No breaking change. | Preserved |
| 52 hooks | Additive: 3 new optional events. | Preserved |
| ESM-only + Node ≥ 18 + zero-dep | Sqlite session is opt-in; default is in-memory + JSON file. | Preserved |
| `toFileUrl()` Korean path workaround | New sandbox/manifest code MUST go through `toFileUrl()` for any dynamic import. | Must enforce |
| DATA POLICY (no external DB / plugin / data egress) | Tracing exporter is local-only NDJSON. CI test asserts no http(s) egress. Reject list blocks all OpenAI-coupled modules. | Enforced |
| Lifecycle phases (spec→plan→build→review→ship→marketing) | Unaffected. | Preserved |

## 10. Final Recommendation

| Question | Answer |
|---|---|
| Adopt as inspiration? | YES — top adoption priority among repos benchmarked to date. |
| Adopt as code dependency? | NO — DATA POLICY (OpenAI tracing exporter, conversation API), Python-only, framework-vs-plugin mismatch. |
| Score gap to close | +2.0 weighted. Patterns 1–5 from Top-5 actions close the gap. |
| Priority sequence | Guardrails → agent-as-tool → Session interface + local tracing → sandbox manifest → HITL run-state. |
| Risk to DNA | LOW if Top-5 actions are implemented additively, with hard CI assertion that no module under `lib/observability/` makes an external HTTP call. |
