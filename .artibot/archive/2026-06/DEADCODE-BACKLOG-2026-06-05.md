# Dead-Code / Unwired-Feature Backlog — Triage Document

> Source: Task #3 (Unit C-audit) — refactor-cleaner (Opus 4.8) sweep, 2026-06-05
> Scope: `plugins/artibot/` — two patterns swept:
> - **Pattern 1** — handler/subscriber exists but no production emitter/dispatcher (the `workflow-advance` shock pattern)
> - **Pattern 2** — symbol exported but zero production consumer (dead export)
> Companion docs (already-cataloged items, NOT re-reported as NEW here):
> `plugins/artibot/docs/WIRING-AUDIT-2026-05-30.md` · `.artibot/WIRE-BACKLOG-TRIAGE.md`
> Method note: `knip` was unusable (worktree artifacts → 3124 false positives); findings are grep-based, verified at the **export-name** granularity to avoid basename-collision false positives.

---

## TL;DR

| ID | Severity | Pattern | Capability | Triage verdict |
|---|---|---|---|---|
| **N1** | HIGH | 1 — emit→void | event-bus: 15 emitter files fire `feature:*`/`skill:*`/`context:*`, sole `on()` subscriber (`feature-tracker`) is dormant | **needs-decision** (activate tracker ↔ gate/remove 15 emits) — *leader-verified ✅* |
| **N2** | MEDIUM | 2 — dead export | `metrics-collector` observability aggregator unwired at both ends (no `registerSource` caller, dashboard reads its own path) | **dormant-by-design** (observability backbone awaiting a consumer surface) — *leader-verified ✅* |
| **N3** | MEDIUM | 2 — dead export | `lib/orchestration/tool-guardrails.js` — per-tool guardrail registry | ~~consolidate~~ → **RECLASSIFIED `dormant-by-documented-design`** (2026-06-05 Task #4): documented public-skill API + unique capability + data-policy test contract — NOT safe-delete. See N3 detail. |
| **N4** | LOW-MED | 2 — dead export | `lib/orchestration/rate-sentinel.js` — rate-limit guard, orphan | **needs-decision** (activate vs drop) |
| **N5** | LOW-MED | 2 — dead export | `lib/orchestration/handoff-filter.js` — handoff history filter, orphan | **needs-decision** — ⚠️ in same Squad-A allowlist as N3 (`no-egress.test.js:28`); re-verify skill refs before any drop. |
| **N6** | LOW | 2 — dead export | `lib/tools/ast-search.js` — ast-grep wrapper, orphan | **dormant-by-design** (capability library, consumer optional) |

**Net**: 6 NEW (beyond WIRE catalog). 2 are `workflow-status`-grade "fully built, zero consumer" (N1, N2). 1 is a duplicate-implementation (N3). 3 are simple orphans (N4–N6). **No code changes made — report/document only.**

---

## N1 — event-bus: 15 emitters fire into a dormant single subscriber `[HIGH · Pattern 1]` · leader-verified ✅

**Location**
- Bus: `lib/core/event-bus.js` (`on` L19, `emit` L51)
- Sole subscriber: `lib/core/feature-tracker.js:172` (`on(def.eventType, …)`) — and `createFeatureTracker` (L159) has **0 production callers** (already dormant per WIRE-05/10)
- Emitters (15 files, all import `{ emit }` from event-bus):
  - `lib/runtime/middleware/router.js:71` · `cache-roi.js:233` · `guardrail.js:249,252` · `context-reset.js:108` · `session-capture.js:211` · `skills.js:265` · `summarization.js:185` · `token-usage.js:278` · `aci-constraint.js:156`
  - `lib/runtime/sprint-contract.js:65,159,183,222`
  - `lib/learning/skill-evolver.js:297,360` · `skill-promoter.js:287` · `eval-calibrator.js:126,188` · `eval-isolator.js:63`
  - `scripts/evals/skill-effectiveness.js:212`

**Evidence** (leader-confirmed independently): production `{ on }` importers = **exactly 1** (`feature-tracker.js:9`); production `{ emit }` importers = **15** (list above). Disambiguated false matches: `lib/runtime/agent-resolver.js:47` defines a *local* `emit()` no-op ("Future: wire to event-bus"), and `lib/autopilot/preflight.js:224` is a telemetry helper — neither touches event-bus. So every `feature:*`/`skill:*`/`context:reset` event emitted by the live middleware pipeline + learning modules reaches **zero handlers** (`emit()` returns 0, L63).

**Why dead/unwired**: identical topology to the `workflow-advance` shock — rich emit side, dormant subscriber side. The root (`createFeatureTracker` uncalled) is cataloged, but the *systemic blast radius* (15 emit sites running every middleware pass) was under-documented.

**Triage: `needs-decision`** — two mutually exclusive directions, trade-off below:

| Direction | What it does | Pros | Cons / risk |
|---|---|---|---|
| **(A) Activate feature-tracker** | Instantiate `createFeatureTracker()` once at a long-lived surface (SessionStart hook or runtime bootstrap) so the 15 emits feed a real Session Intelligence Report | Unlocks already-built observability for free; emits become useful; no emitter churn | Needs a report-surfacing UI/output decision (where does the report go?); adds a subscribed listener to every emit (minor cost); WIRE-10 flagged the subscription mechanism as needing a real consumer first |
| **(B) Gate/remove the 15 emits** | Wrap emits behind a `if (hasListeners(type))` guard, or strip them until a consumer exists | Eliminates pure-waste work on every middleware pass; smaller surface | Throws away built telemetry hooks; if tracker is later activated, all 15 must be re-added; emit() is already cheap (early-return on 0 listeners, L63) so waste is small |

> **Recommendation (advisory)**: emit() already early-returns when listeners=0, so direction (B)'s "waste" is near-zero — the real question is **product**: is the Session Intelligence Report wanted? If yes → (A) is high-value, low-risk. If undecided → leave as-is (dormant, not harmful) and document. Do **not** strip emits (they are the cheap half and the activation seam).

---

## N2 — metrics-collector: observability backbone unwired at both ends `[MEDIUM · Pattern 2]` · leader-verified ✅

**Location**: `lib/core/metrics-collector.js` — `createMetricsCollector` (L76), `defaultCollector` (L172). Re-exported only at `lib/core/index.js:67`. **0 production consumers, 0 tests.**

**Evidence** (leader-confirmed independently):
- (a) `registerSource()` has **0 callers** → no `getStats()` source is ever registered, so `collect()` would return an empty snapshot.
- (b) The actual dashboard `lib/runtime/dashboard/server.mjs` (wired via `bin/artibot-dashboard.mjs`) tails `runtime/events/*.jsonl` through its own `./aggregator.js` (server.mjs:22) — it never imports metrics-collector or any `getStats()`.
- 7 `getStats()` providers exist (`event-bus`, `smart-pipeline`, `knowledge-graph`, `session-memory`, `sandbox`, `feature-tracker`, `cognitive`) that the file header says should be unified "for observability and dashboards" — none flow anywhere.

**Why dead/unwired**: a complete aggregation layer built and disconnected on both the input side (no registered sources) and the output side (dashboard uses a different data path). Not in WIRING-AUDIT (which mentioned individual `getStats()` only as unverified, never the aggregator).

**Triage: `dormant-by-design`** — it is a coherent, self-contained observability primitive with no defect; it simply lacks a consumer surface. Reasonable to keep as a dormant building block (like the GRPO overlays). Activation = a product decision to build an in-memory metrics view that registers the 7 sources and renders them. **No fix recommended without that product intent**; if the team wants zero dormant code, this is a clean deletion candidate (aggregator + its barrel export), but deletion should be a maintainer call, not a wire.

---

## N3 — tool-guardrails.js: duplicate dead guardrail implementation `[MEDIUM · Pattern 2]`

**Location**: `lib/orchestration/tool-guardrails.js` — `registerToolGuardrail` (L30), `clearToolGuardrails` (L49), `evaluateToolInput` (L67), `inspectRegistry` (L95), `ToolGuardrailRejection` (L8). Production consumers **0**, no barrel re-export, no command `.md` invocation. Tests only (`guardrails.test.js`, `no-egress.test.js` import it).

**Evidence**: the **live** guardrail path is `lib/orchestration/guardrails.js` (`runAll` L35 / `runOrThrow` L60), consumed by `lib/runtime/create-artibot-agent.js` + `lib/runtime/middleware/guardrail.js` + `scripts/evals/harness-ablation.js`. `tool-guardrails.js` is a *second*, registry-based guardrail design (per-tool `registerToolGuardrail` + `evaluateToolInput`) that was never wired in.

**Triage: ~~`consolidate`~~ → RECLASSIFIED `dormant-by-documented-design` (2026-06-05, Task #4 deep-dive).** The initial `consolidate` verdict assumed pure JS-import orphanhood; a deeper read for the consolidation pass refuted that:

1. **Documented public-skill API.** `skills/guardrails/SKILL.md` (shipped, level-2, platforms `[claude-code, gemini-cli, codex-cli, cursor]`) names `tool-guardrails.js` as one of its **two** implementation pillars (L22) and teaches agents to call `registerToolGuardrail` (L43) and `evaluateToolInput` (L45, L67). `skills/tool-approval/SKILL.md:35` cross-references it as the preferred alternative ("use `tool-guardrails.js` instead"). Per the WIRING-AUDIT false-positive rule, a skill that surfaces a function as its taught API **is a consumer** — agents invoke it when the skill activates.
2. **Unique capability the live module lacks.** `guardrails.js` (`runAll`/`runOrThrow`) only runs a caller-supplied array against ctx/input with a single throw behavior. `tool-guardrails.js` adds a **stateful per-tool registry** keyed by tool name + **two distinct behaviors** (`reject_content` → returns `{allowed:false, refusal}`; `raise_exception` → throws `ToolGuardrailRejection`). The live policy-rule `middleware/guardrail.js` does per-tool authorization but from *static allow/deny/ask rules*, not a registry of input-inspecting functions. No live module replaces the registry capability.
3. **Explicit data-policy test contract.** `tests/lib/observability/no-egress.test.js:26-34` lists `tool-guardrails.js` in a deliberate **"Squad A owned-files allowlist"** (Phase 2 §4.1) that enforces no-egress on it as a shipped orchestration primitive — alongside `guardrails.js`, `agent-as-tool.js`, `handoff-filter.js`. These were shipped together as a primitive set, not accidental dead code.

**Action taken: NO deletion, NO code change.** Deleting would break the shipped `guardrails` skill contract, the `tool-approval` cross-reference, and remove a capability `guardrails.js` cannot provide. This is dormant-by-design (a documented library/skill primitive awaiting a JS wire-in), functionally identical to N6 (ast-search) and the WIRE-14 skill-exporter precedent (parallel library API, dormant-by-design). Baseline tests confirmed green (14/14) before stopping. If the team still wants zero documented-but-JS-unwired primitives, the correct path is a **product decision to either (a) wire `evaluateToolInput` into the tool-call path, or (b) deprecate the skill section + remove the module together** — never a silent code-only delete.

---

## N4 — rate-sentinel.js: orphan rate-limit guard `[LOW-MED · Pattern 2]`

**Location**: `lib/orchestration/rate-sentinel.js` — `createRateSentinel` (L130), `SlidingWindow` (L19). Consumers **0** (no lib/script/bin importer, no barrel, no command md). Tests only (`tests/orchestration/rate-sentinel.test.js`).

**Evidence**: export-name grep returns only the definition file. A sliding-window rate limiter is fully built + tested but plugged into nothing (no MCP/egress/swarm call path uses it).

**Triage: `needs-decision`** — genuine capability, no defect, but also no current consumer. Either wire it at a rate-sensitive boundary (swarm-client / MCP egress) if rate-limiting is wanted, or drop it. Not harmful while dormant. Defer to maintainer/product on whether rate-limiting is a roadmap item.

---

## N5 — handoff-filter.js: orphan handoff-history filter `[LOW-MED · Pattern 2]`

**Location**: `lib/orchestration/handoff-filter.js` — `filterHandoffHistory` (L22), `keepOnlyTypes` (L37), `SUMMARY_ONLY_INPUT_TYPES` (L8). Consumers **0** in `lib/handoff` or `lib/runtime`. The only test touch (`tests/lib/orchestration/agent-as-tool.test.js`) imports it incidentally.

**Evidence**: no production handoff path (`lib/handoff/*`, runtime middleware) calls `filterHandoffHistory` / `keepOnlyTypes`. The live handoff path (`handoff-builder.js` → `/save` command, `session-start.js` reader) does its own thing and never filters history through this module.

**Triage: `needs-decision`** — built filter for trimming handoff history to summary-only input types; could reduce handoff payload size if wired into the handoff builder, but currently unused. Activate-or-drop is a maintainer call; dormant state is harmless.

---

## N6 — ast-search.js: orphan ast-grep wrapper `[LOW · Pattern 2]`

**Location**: `lib/tools/ast-search.js` — `AstSearch` class (L172), helpers `parseAstGrepOutput`/`escapeRegex`/`patternToRegex`/`extractMetaVarNames` (L396). Consumers **0** (no lib/script/bin/command/skill reference). Tests only (`tests/tools/ast-search.test.js`).

**Evidence**: export-name grep returns only the definition file; no command or skill markdown invokes ast-grep through it.

**Triage: `dormant-by-design`** — a self-contained capability library (structural code search). Such utility libraries legitimately ship ahead of a consumer (a future `/search`-style command or refactor tool). Keep as dormant building block; only delete if the team commits to "no speculative libraries". Lowest priority.

---

## Reconciliation — re-verified samples vs existing audit

> 6 high-value samples directly re-verified this pass. **Not a full re-verification** of the 57 unverified + 29 dormant items — see "Unseen scope" below.

| Item | Audit classification | Current state (2026-06-05) | Evidence |
|---|---|---|---|
| `lib/core/hook-dispatcher.js` `dispatch`/`loadDispatchTable` | dormant (WIRING-AUDIT L70) | **Still dead — duplicate confirmed** | 0 production importers; the real dispatch path is `lib/dispatcher/dispatch-table-loader.js`, used by all 5 `scripts/hooks/_*-dispatcher.js`. Two loaders coexist; the `core/` one is dead → **consolidate** candidate. |
| `createCanceler` (`lib/orchestration/canceler.js:29`) | unverified (audit L52) | **Dead confirmed** | 0 consumers. |
| `agentAsTool` / `defaultSummarizer` (`agent-as-tool.js:33,63`) | dormant (audit L71) | **Dormant — classification accurate** | 0 consumers. |
| `createFeatureTracker` (`feature-tracker.js:159`) | dormant (WIRE-05/10) | **Dormant — but see N1 blast radius** | 0 callers; the 15-emitter side it would consume is live (N1). |
| WIRE-21 swarm-sync `result.version` (`scripts/hooks/swarm-sync.js`) | Applied 2026-06-05 | **Fix verified present** | field mapping corrected as documented. |
| `next-prompt-suggester` / `handoff-builder` | (not a gap candidate) | **LIVE — confirmed not-a-gap** | Invoked by the `/save` command markdown (`commands/save.md:39` `collectHandoffData`, `:48` `suggestFirstPrompts`) — command entrypoint = real consumer. False-positive trap avoided. |

**Confidence band**: WIRE Applied 7 → 1 sampled (swarm-sync, confirmed). Dormant 9 → 3 sampled (all still dormant, reclassification accurate). needs-rework 4 (WIRE-09/10/11/15) → **not re-verified this pass**; trust the existing audit classification.

---

## Unseen scope — false-comfort disclaimers (no overclaiming)

- **knip / ts-prune unusable**: `runtime/autopilot/worktrees/` test artifacts polluted knip with 3124 false-positive "unused files". Export-level findings here rely on grep, **not** a static-analysis tool's reachability graph.
- **Dynamic references undetectable in principle**: `require(variable)` / string-interpolated import paths / reflection-style dispatch cannot be caught by symbol grep. Any of N3–N6 could theoretically have a dynamic consumer (none found, but absence-of-evidence ≠ proof).
- **57 unverified items mostly un-re-verified**: this pass sampled 6 high-value items for reconciliation; the bulk of WIRING-AUDIT's 57 unverified + 29 dormant were not re-swept.
- **Command-md "consumer" leniency**: lib functions referenced inside command `.md` files were treated as "has consumer" (correctly, for `/save` → handoff/next-prompt, which were confirmed to actually invoke). But some md files may *mention a concept* without invoking the function — not every md reference was traced to an actual call. handoff was verified; this was not done exhaustively for all md references.

**Bottom line**: 2 new `workflow-status`-grade fully-dead features found (N1, N2). The rest of the audited surface — the 5 `_*-dispatcher.js` hook mainline, the 11-stage middleware registry (`create-artibot-agent.js:15-26`), the `/save`/handoff path — is correctly wired. WIRE Applied/Dormant reclassifications hold at the sample level. **This is not a guarantee the codebase is otherwise clean** — only that the swept patterns surfaced these 6 plus the reconciled samples.
