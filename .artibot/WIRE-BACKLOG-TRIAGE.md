# WIRE Backlog Triage — Decision Document

> Source: workflow `wk29hwny0`, track `trackB_wiring`
> Date: 2026-06-01
> Author: doc-updater agent

---

## TL;DR

**22 gap candidates parsed. 21 specs produced (WIRE-07 missing — see below). 0 additional items ready to apply right now.**

| Category | Count | Action |
|---|---|---|
| Applied this session | 4 | Done — WIRE-04, 06, 08, 12 |
| Reclassify dormant | 3 | WIRE-01, 02, 19 — no wiring needed |
| needs-rework | 14 | Spec defects block safe application |
| **Total accounted** | **21** | WIRE-07 produced no spec (see gap note) |

---

## Table 1 — Applied (4)

These four were verified, committed, and are live on `master`.

| ID | Capability | Commit | Status |
|---|---|---|---|
| WIRE-04 | cache-roi middleware (`createCacheRoiMiddleware`) — measures prompt-cache ROI / cache-hit economics | `8003662` | Applied |
| WIRE-06 | smart-pipeline Zero-Waste condition-based middleware selection — dynamic pipeline filter | `8003662` | Applied |
| WIRE-08 | Autopilot cost-tracker — `notePhaseCost` + `buildCostWarningInstruction` re-exported onto `engine.*` namespace | `3e2cbdc` | Applied |
| WIRE-12 | lifecycle-router CLI bridge — new `scripts/route-lifecycle.mjs` exposing `routeLifecycle` / `routeByContext` / `suggestNext` | `61dde1f` | Applied |

---

## Table 2 — Reclassify Dormant (3)

These items have `isRealGap=false` and are intentional-dormant, not defects. They align with the project's dormant-by-design philosophy (see memory: `project-learning-activation` — GRPO overlays dormant-by-design, not deprecated; reactivation is a separate explicit human decision).

| ID | Capability | isRealGap | Why dormant |
|---|---|---|---|
| WIRE-01 | GRPO reward-pipeline emitter — `createRewardMetrics.recordReward` writes `reward-metrics.json` | false | `reward-metrics.js` carries an explicit `DORMANT BY DESIGN (intentional, not deprecated)` banner (lines 30-54). No production caller is the deliberate state per GRPO CLOSED v4.19.1 decision. Activating would flip a frozen subsystem without explicit maintainer approval. |
| WIRE-02 | knowledge-transfer `promoteToSystem1` / `bootstrapPromote` — System2 → System1 promotion | false | Gap framing is wrong: upstream `hotSwap()` itself has zero production callers. WIRE-02 is an internal dedup (not a wiring), leaves dormancy unchanged, and would break `knowledge-demotion-promote.test.js` (spy contract invalidated). |
| WIRE-19 | lifecycle middleware config gating (`createLifecycleMiddleware`) | false | All spec anchors were confirmed nonexistent by the adversarial verifier (Glob/Read returned 0 matches for the claimed files and line numbers). The spec is a phantom — nothing to wire. |

---

## Table 3 — Needs Rework (14)

Fourteen items carry verified or unverified spec defects that make blind application unsafe (guardrail risk, broken tests, or unresolvable call sites). Items with `isRealGap=false` are separately flagged as dormant candidates.

### 3a — realGap=true (6 items): genuine gaps, but spec must be fixed before applying

| ID | Capability | risk | conf | Core rework reason |
|---|---|---|---|---|
| WIRE-03 | Per-teammate workflow plan attachment (`task.meta.workflowPlan` → subagents contract) | low | 0.78 | Spec cites wrong file path: `lib/workflow/workflow-plan.js` does not exist; real file is `lib/cognitive/workflow-plan.js`. Line numbers also drift. Logic is correct; fix the path/line citations only. |
| WIRE-09 | phase-replay `replayPhase` — re-runs single autopilot phase for recovery | low | — | Blocking defect: `PHASE_TO_RUNNER` functions take a full `state` object and return an instruction, not the `{status,sha}` contract `replayPhase` expects from `opts.phaseRunner`. No adapter is provided. Happy-path testStub assertion will fail on correct wiring. `editSketch` field referenced as "see editSketch field" but omitted. |
| WIRE-10 | `createFeatureTracker` — Session Intelligence Report feature-usage instantiation | low | 0.88 | Core mechanism fictional: `create-artibot-agent.js` has no event bus and middleware emit no `feature:*` events. Tracker would subscribe to a bus nothing publishes to, recording zero activations. The key testStub assertion (`totalActivations >= 1`) would fail immediately. |
| WIRE-11 | marketplace `detectConflicts` — conflict detection in `installFromUrl` | low | 0.78 | `detectConflicts` keys on a `files[]` array from a PackageManifest. Extension manifests (`artibot.ext.json`) likely carry no `files[]` field — spec admits the guard would be a permanent no-op in production. Schema mismatch must be resolved before wiring is meaningful. |
| WIRE-15 | `detectHarness` / `UniversalHarnessAdapter` — auto-detect host harness at CLI bootstrap | medium | 0.55 | `bin/artibot.js` call-site not re-confirmed (tool output failed mid-session). Spec reuses `pluginRoot`/`config` "already resolved in bootstrap" but their presence in that scope is unverified. Low confidence (0.55) explicitly flagged by spec author. |
| WIRE-16 | `homoglyph-detector` `normalizeHomoglyphs` — defeat mixed-script spoofing in `scrub()` | medium | 0.82 | Flagship test case is non-discriminating: the proposed `scrub('contact usеr@example.com today')` ALREADY returns `[EMAIL]` on unwired code (regex matches `r@`). Stub would pass without the fix, proving nothing. Replace with a case the unwired path genuinely fails (e.g. `'mail аdmin@corp.io'` with Cyrillic `а`). Line refs also drift (spec 144/178 vs actual 140/176). |

### 3b — realGap=false (8 items): dormant candidates — recommend downgrading before spec work

These 8 items have `isRealGap=false` or could not confirm a real gap. They are plausible dormant-by-design candidates and should be reviewed for formal dormant classification before investing in rework.

| ID | Capability | risk | conf | Core rework reason / dormant signal |
|---|---|---|---|---|
| WIRE-05 | `createFeatureTracker` instantiation — Session Intelligence Report / statusline (same capability as WIRE-10, earlier spec) | low | 0.82 | `isRealGap=false`. Entire verification done in a sandbox where the Artibot repo was not mounted; zero file evidence. Dormant-by-design flag-gate pattern (`ux.featureIndicator.enabled`) aligns with known intentional-dormant overlays. |
| WIRE-13 | playbook-registry loaders — `listPlaybooks`, `getPlaybook` via new `scripts/playbook-diag.js` | low | 0.82 | `isRealGap=false, integrationPointExists=false`. All tools returned empty output; nothing confirmed. Spec admits the bash block in `playbook.md:49-51` is "currently absent" — inferred from another command, not observed. |
| WIRE-14 | `skill-exporter` `exportForGemini/Codex/Cursor` — cross-harness skill export | medium | 0.78 | `isRealGap=false, integrationPointExists=false`. Tool failure; original gap path (`lib/adapters/skill-exporter.js`) is wrong per spec's own note. Requires new write-loop embedded in a markdown inline script; non-overlapping tool coverage between library and script path; barrel inconsistency. Dormant-by-design possible. |
| WIRE-17 | `token-rotation` — `generateToken/rotateToken/isTokenValid` wired into `swarm-client.buildHeaders` | medium | 0.80 | `isRealGap=false, integrationPointExists=false`. Tool failure; `swarm-client.js` and `token-rotation.js` not confirmed. Spec's own note admits minted tokens are NOT server-validated — client-side bookkeeping only, not real auth upgrade. Could be reclassify-dormant. |
| WIRE-18 | `lsp-client collectDiagnostics` — wired into `clean-state-check.js` hook | medium | 0.82 | `isRealGap=false, integrationPointExists=false`. Tool failure; nothing confirmed. Editsketch has conflicting line refs (line 81 vs "replace lines 81-94") and unresolved `buildResult()` dead-code decision. Converts advisory hook to 30s-per-tool tsc/eslint spawner. |
| WIRE-21 | swarm-sync result field mapping — `result.version` vs `result.uploadVersion` | low | 0.95 | `isRealGap=false, integrationPointExists=false`. Tool failure; `swarm-sync.js` lines 98-99 and `sync-scheduler.js` return shape not confirmed. High stated confidence (0.95) is inconsistent with zero file reads. Despite being a cosmetic stderr-only fix, file confirmation required before applying. |
| WIRE-20 | extension registry population — drain `discoverExtensions` into `createExtensionRegistry` | medium | 0.82 | `isRealGap=false, integrationPointExists=false`. Environment tool failure prevented verifying `discoverExtensions` existence and return shape, `toFileUrl` export path, and the consumer sites at lines 118/278/298. Internal contradiction in spec: original gap premise ("registry write-only") was self-refuted. Re-verify all four files before wiring; determine dormant-by-design intent first. |
| WIRE-22 | adapter-utils — `stripClaudeSpecificRefs / buildSkillFrontmatter / stripAgentTeamsRefs` | low | 0.82 | `isRealGap=false, integrationPointExists=false`. Spec's own editSketch says "No edit to adapter-utils.js" — no independent wiring action. Entirely transitive on WIRE-14 / WIRE-15. Naming inconsistency (`stripAgentFrontmatter` vs `stripAgentTeamsRefs`). Merge into WIRE-14/15 or scope to pure test coverage only. |

---

## Recommended Next Actions

### (a) Formal dormant documentation — 3 confirmed dormants

WIRE-01, WIRE-02, WIRE-19 should be added to `plugins/artibot/docs/WIRING-AUDIT-2026-05-30.md` (or the equivalent living audit) under an "Intentionally Dormant" section with explicit rationale, so future gap scans do not re-flag them.

### (b) Dormant candidate review — 8 realGap=false needs-rework items

The 8 items in Table 3b (WIRE-05, 13, 14, 17, 18, 20, 21, 22) should be reviewed against maintainer intent:
- If dormant-by-design: add to the formal dormant list and close the spec.
- If genuinely wanted: re-verify files in a functioning tool environment before spec rework.

Priority order for review: WIRE-21 (lowest risk, single field rename, high confidence once confirmed) → WIRE-18 (advisory hook enhancement) → WIRE-17 (auth lifecycle) → rest.

### (c) Spec rework — 6 realGap=true needs-rework items

Priority order based on confidence and risk:

1. **WIRE-03** (conf 0.78, low risk) — Easiest fix: correct the `workflow-plan.js` file path from `lib/workflow/` to `lib/cognitive/` and update line citations. Logic is verified correct; this is documentation-only rework.
2. **WIRE-16** (conf 0.82, medium risk) — Fix the non-discriminating test case and update line references. The homoglyph normalization logic is sound; only the test needs to be made meaningful.
3. **WIRE-11** (conf 0.78, low risk) — Resolve the extension manifest schema question: does `artibot.ext.json` carry a `files[]` field? If not, rework to derive file sets from disk rather than manifest.
4. **WIRE-09** (conf unknown, low risk) — Write the `phaseRunner` adapter that bridges `PHASE_TO_RUNNER(state)` → `{status,sha}`. Rewrite the happy-path test to inject a stub runner.
5. **WIRE-10** (conf 0.88, low risk) — Either introduce `feature:*` event-bus emissions in the middleware pipeline first, or replace the subscription approach with explicit `featureTracker.record(...)` calls at middleware-completion points.
6. **WIRE-15** (conf 0.55, medium risk) — Re-read `bin/artibot.js` to confirm the startup path and whether `pluginRoot`/`config` exist in scope at the chosen insertion point. Confidence is too low to proceed without file confirmation.

---

## Verification: 22-item count reconciliation

| Range | IDs present in `full[]` | Count |
|---|---|---|
| Table 1 — Applied | WIRE-04, 06, 08, 12 | 4 |
| Table 2 — Dormant | WIRE-01, 02, 19 | 3 |
| Table 3a — rework, realGap=true | WIRE-03, 09, 10, 11, 15, 16 | 6 |
| Table 3b — rework, realGap=false | WIRE-05, 13, 14, 17, 18, 20, 21, 22 | 8 |
| **Subtotal (specs produced)** | | **21** |
| **WIRE-07 — spec not produced** | | **1** |
| **Total parsed** | | **22** |

### WIRE-07 missing spec — root cause

Top-level `logs[1]` in `workflow-wk29hwny0-result.json` records: `"pipeline[6] failed: agent({schema}): subagent completed without calling StructuredOutput (after 2 in-conversation nudges)"`. Pipeline slots are 0-indexed, so pipeline[6] is the 7th agent slot — inferred to correspond to WIRE-07 based on pipeline ordering (the JSON string "WIRE-07" does not appear anywhere in the result file; this is an inference, not a confirmed mapping). That subagent exhausted its turn budget without emitting a `StructuredOutput` call, so no spec was written to the `full[]` array. `totalParsed=22` reflects that the gap candidate was identified and dispatched; `specsProduced=21` reflects that the spec for WIRE-07 was never delivered. The capability WIRE-07 targeted is not captured anywhere in this result file.

**Recommended action**: re-run a single-agent spec generation pass for WIRE-07 to recover the missing spec, then triage it normally.
