# WIRE Backlog Triage — Decision Document

> Source: workflow `wk29hwny0`, track `trackB_wiring`
> Date: 2026-06-01
> Author: doc-updater agent

---

## TL;DR

**22 gap candidates parsed. 21 specs produced (WIRE-07 missing — see below). 0 additional items ready to apply right now.**

| Category | Count | Action |
|---|---|---|
| Applied | 7 | Done — WIRE-04, 06, 08, 12, **03**, **21**, **16** (03/21/16 applied 2026-06-05) |
| Reclassify dormant | 10 | WIRE-01, 02, 19 + **05, 13, 14, 17, 18, 20** (2026-06-05 review) + **11** (2026-06-22 — schema-design precedes wiring) — no wiring needed |
| Not a gap (already live) | 1 | **WIRE-22** — adapter-utils consumed by 5 adapters |
| needs-rework | 3 | WIRE-09, 10, 15 — spec defects block safe application |
| **Total accounted** | **21** | WIRE-07 produced no spec (see gap note) |

> **2026-06-05 dormant-cleanup review**: the 8 `realGap=false` candidates were re-verified with full repo access. Dispositions — 6 dormant (05/13/14/17/18/20), 1 fixed (**WIRE-21**: was a phantom-path false negative; real bug at `scripts/hooks/swarm-sync.js:98-99`, now fixed), 1 already-live (**WIRE-22**). Full evidence: `plugins/artibot/docs/WIRING-AUDIT-2026-05-30.md` → "Dormant Reclassification (2026-06-05 follow-up)".

---

## Table 1 — Applied (7)

These were verified, committed, and are live on `master`.

| ID | Capability | Commit | Status |
|---|---|---|---|
| WIRE-04 | cache-roi middleware (`createCacheRoiMiddleware`) — measures prompt-cache ROI / cache-hit economics | `8003662` | Applied |
| WIRE-06 | smart-pipeline Zero-Waste condition-based middleware selection — dynamic pipeline filter | `8003662` | Applied |
| WIRE-08 | Autopilot cost-tracker — `notePhaseCost` + `buildCostWarningInstruction` re-exported onto `engine.*` namespace | `3e2cbdc` | Applied |
| WIRE-12 | lifecycle-router CLI bridge — new `scripts/route-lifecycle.mjs` exposing `routeLifecycle` / `routeByContext` / `suggestNext` | `61dde1f` | Applied |
| WIRE-03 | Per-teammate workflow plan attachment — `subagents.js` contract surfaces `parentEffort`/`perAgentBudget`/`teammates[]` from `task.meta.workflowPlan`. Spec line citations corrected (workflow-plan.js inline 227-237 / teammates 240-246; runtime-prompt.js 560). | _2026-06-05_ | Applied |
| WIRE-21 | swarm-sync result field mapping — `scripts/hooks/swarm-sync.js:98-99` read non-existent `result.uploadVersion`/`downloadVersion`; `onSessionEnd` returns `{uploaded,downloaded,version}` (sync-scheduler.js:324-330). Fixed to `result.version`. Reclassified realGap=false→true during 2026-06-05 review (phantom-path false negative). | _2026-06-05_ | Applied |
| WIRE-16 | homoglyph defense in PII scrubber — `scrub()` (pii-scrubber.js) normalizes mixed Latin+Cyrillic/Greek homoglyphs via `checkMixedScript`/`normalizeHomoglyphs` before regex masking, catching disguised PII. Dedicated `stats.homoglyphNormalized` counter (no byCategory pollution). Rework fixed the non-discriminating flagship test, line drift (140/176/327), and stats conflation; data-egress-guard import was already absent (verdict's "unused import" was stale). 6 discriminating tests. | _2026-06-05_ | Applied |

---

## Table 2 — Reclassify Dormant (10)

> 3 original (WIRE-01/02/19) + 6 added by the 2026-06-05 dormant-cleanup review (WIRE-05/13/14/17/18/20) + 1 added 2026-06-22 (WIRE-11 — schema-design precedes wiring). Full evidence in `plugins/artibot/docs/WIRING-AUDIT-2026-05-30.md`.

These items have `isRealGap=false` and are intentional-dormant, not defects. They align with the project's dormant-by-design philosophy (see memory: `project-learning-activation` — GRPO overlays dormant-by-design, not deprecated; reactivation is a separate explicit human decision).

| ID | Capability | isRealGap | Why dormant |
|---|---|---|---|
| WIRE-01 | GRPO reward-pipeline emitter — `createRewardMetrics.recordReward` writes `reward-metrics.json` | false | `reward-metrics.js` carries an explicit `DORMANT BY DESIGN (intentional, not deprecated)` banner (lines 30-54). No production caller is the deliberate state per GRPO CLOSED v4.19.1 decision. Activating would flip a frozen subsystem without explicit maintainer approval. |
| WIRE-02 | knowledge-transfer `promoteToSystem1` / `bootstrapPromote` — System2 → System1 promotion | false | Gap framing is wrong: upstream `hotSwap()` itself has zero production callers. WIRE-02 is an internal dedup (not a wiring), leaves dormancy unchanged, and would break `knowledge-demotion-promote.test.js` (spy contract invalidated). |
| WIRE-19 | lifecycle middleware config gating (`createLifecycleMiddleware`) | false | All spec anchors were confirmed nonexistent by the adversarial verifier (Glob/Read returned 0 matches for the claimed files and line numbers). The spec is a phantom — nothing to wire. |
| WIRE-05 | `createFeatureTracker` — Session Intelligence Report instantiation | false | `lib/core/feature-tracker.js` exists; `createFeatureTracker` 0 production callers; no `ux.featureIndicator` flag in `artibot.config.json`. Unwired utility awaiting a Session Intelligence surface. (= WIRE-10) |
| WIRE-13 | playbook-registry loaders `listPlaybooks` / `getPlaybook` | false | Exported via `lib/core/index.js` barrel but 0 production consumers; spec remedy = a NEW `scripts/playbook-diag.js` (absent) = feature add, not a wire. |
| WIRE-14 | skill-exporter `exportForGemini/Codex/Cursor` | false | Functions exist (skill-exporter.js:373/383/393), re-exported via index.js:39 only; shipped `/export` runs `scripts/export-to-tool.mjs` which does NOT import skill-exporter = parallel library API (dormant-by-design). |
| WIRE-17 | token-rotation → swarm-client.buildHeaders | false | `lib/privacy/token-rotation.js` exists; `swarm-client.js#buildHeaders:160` does not import it; minted tokens not server-validated = client-only bookkeeping, no auth benefit until server counterpart exists. |
| WIRE-18 | lsp-client `collectDiagnostics` → clean-state-check hook | false | `lib/system/lsp-client.js` + `scripts/hooks/clean-state-check.js` both exist; wiring converts an advisory hook into a per-tool tsc/eslint spawner (~30s/tool) — intentionally advisory. |
| WIRE-20 | extension registry population (`discoverExtensions` → `createExtensionRegistry`) | false | `createExtensionRegistry` IS wired (create-artibot-agent.js:200/209) but `discoverExtensions` (extension-loader.js:160) has 0 callers → registry consumed via explicit injection; auto-discovery is a separate unwired feature. Spec "write-only" premise refuted. |
| WIRE-11 | marketplace `detectConflicts` → `installFromUrl` conflict guard | false (2026-06-22 reclassify) | **Schema-design precedes wiring.** `detectConflicts` keys entirely on a `files[]` string-array (`marketplace.js:186-197`, type `PackageManifest` at `marketplace.js:80-88`), but `installFromUrl` consumes a different manifest — `artibot.ext.json` — whose fixed schema has **no `files` field** (REQUIRED+OPTIONAL fields at `extension-loader.js:25-30`). Even deriving `files[]` from the cloned disk is structurally a no-op: each extension installs under its own namespace `~/.claude/plugins/artibot-ext-<name>/` (`marketplace-installer.js:24,122`), so two extensions can never own the same path → conflict set is permanently empty. `listInstalled` also returns no `files` (`marketplace-installer.js:170-193`). Wiring requires a prior ADR unifying `PackageManifest.files[]` ↔ `artibot.ext.json` schema — not a wire. |

> WIRE-21 and WIRE-22 were also in the original `realGap=false` set but reclassified on 2026-06-05: **WIRE-21 → applied** (real bug, see Table 1); **WIRE-22 → not a gap** (adapter-utils consumed by 5 adapters, already live).

---

## Table 3 — Needs Rework (3)

Three `realGap=true` items carry verified spec defects that make blind application unsafe (guardrail risk, broken tests, or unresolvable call sites). WIRE-03 and WIRE-16 were reworked and applied 2026-06-05 (→ Table 1). WIRE-11 was reclassified dormant 2026-06-22 (→ Table 2 — schema-design precedes wiring). The 8 original `realGap=false` needs-rework items were dispositioned in the 2026-06-05 review (6 → Table 2 dormant, WIRE-21 → applied, WIRE-22 → not-a-gap).

### 3a — realGap=true (3 items): genuine gaps, but spec must be fixed before applying

> WIRE-03 & WIRE-16 (were here) applied 2026-06-05 — moved to Table 1.
> WIRE-11 (was here) reclassified dormant 2026-06-22 — moved to Table 2 (the `detectConflicts`/`installFromUrl` schema mismatch makes any wire a permanent no-op; ADR-level schema unification must precede it).

| ID | Capability | risk | conf | Core rework reason |
|---|---|---|---|---|
| WIRE-09 | phase-replay `replayPhase` — re-runs single autopilot phase for recovery | low | — | Blocking defect: `PHASE_TO_RUNNER` functions take a full `state` object and return an instruction, not the `{status,sha}` contract `replayPhase` expects from `opts.phaseRunner`. No adapter is provided. Happy-path testStub assertion will fail on correct wiring. `editSketch` field referenced as "see editSketch field" but omitted. |
| WIRE-10 | `createFeatureTracker` — Session Intelligence Report feature-usage instantiation | low | 0.88 | Core mechanism fictional: `create-artibot-agent.js` has no event bus and middleware emit no `feature:*` events. Tracker would subscribe to a bus nothing publishes to, recording zero activations. The key testStub assertion (`totalActivations >= 1`) would fail immediately. NOTE: WIRE-05 (same capability) reclassified dormant 2026-06-05 — reconcile before reworking. |
| WIRE-15 | `detectHarness` / `UniversalHarnessAdapter` — auto-detect host harness at CLI bootstrap | medium | 0.55 | `bin/artibot.js` call-site not re-confirmed (tool output failed mid-session). Spec reuses `pluginRoot`/`config` "already resolved in bootstrap" but their presence in that scope is unverified. Low confidence (0.55) explicitly flagged by spec author. |

### 3b — realGap=false (8 items): DISPOSITIONED 2026-06-05 ✅

The 8 `realGap=false` candidates — all originally unconfirmed due to sandbox tool failures — were re-verified with full repo access. Dispositions below; full file:line evidence in `plugins/artibot/docs/WIRING-AUDIT-2026-05-30.md` → "Dormant Reclassification (2026-06-05 follow-up)".

| ID | Disposition | Key evidence |
|---|---|---|
| WIRE-05 | → Table 2 **dormant** | `feature-tracker.js` exists, 0 callers, no `ux.featureIndicator` flag |
| WIRE-13 | → Table 2 **dormant** | registry exported, 0 consumers; remedy = new diag script (feature) |
| WIRE-14 | → Table 2 **dormant-by-design** | `export-to-tool.mjs` does NOT import skill-exporter (confirmed bypass) |
| WIRE-17 | → Table 2 **dormant-by-design** | client-only token bookkeeping, no server validation |
| WIRE-18 | → Table 2 **dormant-by-design** | advisory hook intentionally not a tsc/eslint spawner |
| WIRE-20 | → Table 2 **dormant** | `createExtensionRegistry` wired (cab.js:200), `discoverExtensions` 0 callers |
| WIRE-21 | → Table 1 **APPLIED** ✅ | real bug at `scripts/hooks/swarm-sync.js:98-99` (phantom-path false negative); fixed to `result.version` |
| WIRE-22 | **Not a gap — closed** | adapter-utils consumed by 5 adapters (already live) |

---

## Recommended Next Actions

### (a) Formal dormant documentation — 3 confirmed dormants ✅ DONE (2026-06-05)

WIRE-01, WIRE-02, WIRE-19 documented in `plugins/artibot/docs/WIRING-AUDIT-2026-05-30.md` → "Dormant Reclassification (2026-06-05 follow-up)" + appended to the intentional-dormant list, so future gap scans do not re-flag them.

### (b) Dormant candidate review — 8 realGap=false items ✅ DONE (2026-06-05)

All 8 re-verified with full repo access. Outcome: 6 dormant (WIRE-05/13/14/17/18/20 → Table 2), 1 fixed (WIRE-21 — was a phantom-path false negative; real bug at `scripts/hooks/swarm-sync.js:98-99`, now applied → Table 1), 1 closed as already-live (WIRE-22 — adapter-utils consumed by 5 adapters). Full evidence in the audit doc reclassification section.

### (c) Spec rework — 3 realGap=true needs-rework items

Priority order based on confidence and risk:

- ~~**WIRE-03**~~ ✅ **Applied 2026-06-05** — path/line citations corrected (`lib/cognitive/workflow-plan.js`, inline 227-237 / teammates 240-246; `runtime-prompt.js:560`), surgical wire landed in `subagents.js` contract + 3 regression tests. See Table 1.
- ~~**WIRE-16**~~ ✅ **Applied 2026-06-05** — homoglyph normalization wired into `pii-scrubber.scrub()` with a dedicated `stats.homoglyphNormalized` counter; non-discriminating flagship test replaced with 6 discriminating cases; line drift (140/176/327) corrected; data-egress-guard "unused import" was already absent (stale verdict note). See Table 1.

- ~~**WIRE-11**~~ ✅ **Dormant confirmed 2026-06-22** (→ Table 2) — investigation showed any wire would be a permanent no-op: `detectConflicts` keys on `PackageManifest.files[]` (`marketplace.js:186-197`) while `installFromUrl` consumes the `artibot.ext.json` manifest, which has no `files` field (`extension-loader.js:25-30`); per-extension namespace install (`marketplace-installer.js:24,122`) makes path conflicts structurally impossible. Wiring requires an ADR-level unification of `PackageManifest.files[]` ↔ `artibot.ext.json` schema before it is meaningful.

1. **WIRE-09** (conf unknown, low risk) — Write the `phaseRunner` adapter that bridges `PHASE_TO_RUNNER(state)` → `{status,sha}`. Rewrite the happy-path test to inject a stub runner.
2. **WIRE-10** (conf 0.88, low risk) — Either introduce `feature:*` event-bus emissions in the middleware pipeline first, or replace the subscription approach with explicit `featureTracker.record(...)` calls at middleware-completion points. Reconcile with WIRE-05 (same capability, reclassified dormant 2026-06-05).
3. **WIRE-15** (conf 0.55, medium risk) — Re-read `bin/artibot.js` to confirm the startup path and whether `pluginRoot`/`config` exist in scope at the chosen insertion point. Confidence is too low to proceed without file confirmation.

---

## Verification: 22-item count reconciliation

> This table is the **immutable original-parse record** (where each of the 21 produced specs sat at triage time, 2026-06-01). Current dispositions have since changed — see the "Current status (2026-06-05 → 2026-06-22 갱신)" note below.

| Range | IDs present in `full[]` | Count |
|---|---|---|
| Table 1 — Applied (original) | WIRE-04, 06, 08, 12 | 4 |
| Table 2 — Dormant (original) | WIRE-01, 02, 19 | 3 |
| Table 3a — rework, realGap=true | WIRE-03, 09, 10, 11, 15, 16 | 6 |
| Table 3b — rework, realGap=false | WIRE-05, 13, 14, 17, 18, 20, 21, 22 | 8 |
| **Subtotal (specs produced)** | | **21** |
| **WIRE-07 — spec not produced** | | **1** |
| **Total parsed** | | **22** |

**Current status (2026-06-05 → 2026-06-22 갱신)** — Applied **7** (04/06/08/12 + 03/16/21) · Dormant **10** (01/02/19 + 05/13/14/17/18/20 + 11) · Not-a-gap **1** (22) · needs-rework **3** (09/10/15) · WIRE-07 spec missing **1**. Sum = 22.

### WIRE-07 missing spec — root cause

Top-level `logs[1]` in `workflow-wk29hwny0-result.json` records: `"pipeline[6] failed: agent({schema}): subagent completed without calling StructuredOutput (after 2 in-conversation nudges)"`. Pipeline slots are 0-indexed, so pipeline[6] is the 7th agent slot — inferred to correspond to WIRE-07 based on pipeline ordering (the JSON string "WIRE-07" does not appear anywhere in the result file; this is an inference, not a confirmed mapping). That subagent exhausted its turn budget without emitting a `StructuredOutput` call, so no spec was written to the `full[]` array. `totalParsed=22` reflects that the gap candidate was identified and dispatched; `specsProduced=21` reflects that the spec for WIRE-07 was never delivered. The capability WIRE-07 targeted is not captured anywhere in this result file.

**Recommended action**: re-run a single-agent spec generation pass for WIRE-07 to recover the missing spec, then triage it normally.
