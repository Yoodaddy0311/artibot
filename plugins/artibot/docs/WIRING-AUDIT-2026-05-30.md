# Wiring Audit Report (2026-05-30)

> 23-unit parallel audit (Opus 4.8, 43 agents). 182 findings → **79 confirmed REAL gaps** / 29 intentional-dormant / 0 refuted. Of the 79, **22 passed adversarial verify**; 57 unverified (verdict-name mismatch) — need triage.

> ⚠️ Caveat: many "no caller in lib/" findings may be CLI/MCP/command-invoked utilities, not dead code. Triage before fixing.

## Verified gaps (22, adversarially confirmed)

| Sev | Subsystem | Capability | Missing link |
|---|---|---|---|
| high | learning/grpo reward pipeline | createRewardMetrics / recordReward — writes reward episodes to runtime | No production emitter calls createRewardMetrics({metricsPath:runtime/reward-metrics.json}).recordReward(sessionId, reward, components, meta) |
| medium | learning voyager/lifelong/knowledge | knowledge-transfer: promoteToSystem1() + bootstrapPromote() | knowledge-demotion.js#_processPromotions가 인라인 승급 대신 knowledge-transfer.js#promoteToSystem1을 호출하도록 배선하거나, 두 함수를 dead export로 제거. 현재는 동일 로직이 두 |
| medium | runtime middleware | tasks.js workflowPlan attachment (task.meta.workflowPlan via buildWork | runtime-prompt.js (or subagents.js) must read state.context.tasks.meta.workflowPlan and serialize the per-teammate effort/budget into the in |
| medium | runtime middleware | cache-roi middleware (createCacheRoiMiddleware) | Two fixes needed: (1) register cache-roi in create-artibot-agent.js middlewareRegistry + defaultPipeline (import createCacheRoiMiddleware, a |
| ~~medium~~ RESOLVED | runtime middleware | feature-indicator / feature activation tracker (createFeatureTracker) | REMOVED (B2, 2026-06-20). createFeatureTracker deleted: 0 production callers AND session-level aggregation is architecturally impossible (per-prompt short-lived hook processes + in-memory bus can't survive process exit). The runtime middleware `feature:*` emits remain as honest fire-and-forget observability points (zero-subscriber emit = intentional no-op). |
| medium | runtime core | lib/runtime/smart-pipeline.js (Zero-Waste condition-based middleware s | create-artibot-agent.js must import smart-pipeline and use it to build/filter the middleware list (or a hook/middleware must populate state. |
| medium | runtime core | lib/runtime/sprint-contract.js (pre-agreement done-criteria protocol) | A production caller (e.g. /team or /implement orchestration, or a SubagentStart/TaskCreate hook) must import sprint-contract and create+agre |
| medium | autopilot aux | cost-tracker.js — per-phase recording & budget-danger gate (engine.not | Either (a) re-export notePhaseCost + buildCostWarningInstruction from engine.js/index.js so the orchestrator-facing 'engine.*' namespace res |
| medium | autopilot aux | phase-replay.js (replayPhase) | No command/engine entry point invokes replayPhase. Needs a CLI/command subcommand (e.g. ':replay <sessionId> <phase>') or an engine resume b |
| ~~medium~~ RESOLVED | core hooks/dispatch | feature-tracker.js createFeatureTracker (Session Intelligence Report / | REMOVED (B2, 2026-06-20). See runtime-middleware row above — deleted as unreachable theater rather than wired. |
| medium | core marketplace/playbook/router | marketplace.js semver/diff/plan engine (createInstallPlan, computeUpda | An /install or /update execution path must actually import and call createInstallPlan(profile)/computeUpdateDiff(installed,incoming)/detectC |
| medium | core marketplace/playbook/router | lifecycle-router.js routing API (routeLifecycle, routeByContext, sugge | The lifecycle commands need an executable bridge (a scripts/ entry invoked via Bash, or a runtime middleware/dispatcher) that imports routeL |
| medium | core marketplace/playbook/router | playbook-registry.js loaders (listPlaybooks, getPlaybook, loadSystemPl | /playbook command (or an orchestration runner) must call listPlaybooks()/getPlaybook() via an executable script instead of re-implementing l |
| medium | adapters/sdk | skill-exporter exportForGemini/exportForCodex/exportForCursor/exportFo | The shipped /export command path bypasses skill-exporter entirely (uses export-to-tool.mjs). To wire skill-exporter, export.md step 2 would  |
| medium | adapters/sdk | universal-harness: detectHarness / UniversalHarnessAdapter / mapHooks  | Nothing calls detectHarness() at startup and no entry constructs UniversalHarnessAdapter. To activate, a runtime bootstrap (e.g. bin/artibot |
| medium | privacy/visual/system | homoglyph-detector (detectHomoglyphs / checkMixedScript / normalizeHom | No production caller wires homoglyph detection into any data path. To activate: pii-scrubber.js or data-egress-guard.js should call detectHo |
| medium | privacy/visual/system | token-rotation (generateToken / rotateToken / isTokenValid / revokeTok | No production component issues, validates, or rotates tokens. To activate: swarm-client/swarm auth or an MCP/egress credential path must cal |
| medium | privacy/visual/system | lsp-client (collectDiagnostics / collectTscDiagnostics / collectEslint | No production path invokes diagnostic collection. To activate: a PostToolUse/Stop hook (e.g. a clean-state checker) or the verify/build lib  |
| low | runtime middleware | lifecycle middleware config gating (createLifecycleMiddleware) | If lifecycle setup/teardown is intended to run, add 'lifecycle' to artibot.config.json#/runtime/middleware. If intentionally disabled, the r |
| low | core marketplace/playbook/router | extension.js singleton registry (defaultRegistry, registerSkill, regis | Nothing reads the in-memory registry: registerHook(event,handler) is never drained by a dispatcher, and registerSkill is never consulted by  |
| low | swarm | swarm-sync.js result field mapping (result.uploadVersion / result.down | swarm-sync.js should read result.version (not result.uploadVersion); the result.downloaded branch is dead since onSessionEnd never downloads |
| low | adapters/sdk | adapter-utils stripClaudeSpecificRefs / buildSkillFrontmatter / stripA | Reachable only through the dormant skill-exporter -> lib/adapters chain. Becomes live automatically once exportFor* / the platform adapters  |

## Unverified claimed gaps (57) — grouped by subsystem

| Subsystem | count | high | capabilities (short) |
|---|---|---|---|
| learning/memory | 6 | 3 | episodic.appendEpisode; working-compaction onCompact; createWorkingStore wired wit; isHierarchicalEnabled config; createPromoter / runPromotio; memory/metrics.js createMetr |
| mcp | 6 | 5 | Artibot MCP server; bin/artibot-mcp.mjs bridge w; builtinTools; memory-bridge createMemoryBr; skills-bridge / agents-bridg; createArtibotMcpServer optio |
| learning core | 5 | 0 | pipeline.js processUserMessa; pipeline.js initLearning; pipeline.js runLearningCycle; vault.js addEntry/getEntries; wakeup-scheduler.js requestW |
| observability/handoff/context/intent | 5 | 2 | OTEL exporter chain; Config flag observability.ot; Session aggregator recordSes; Config flag observability.se; Trace/Span tracing primitive |
| config flags audit | 5 | 0 | context.importCacheTTL; automation.intentDetection; cognitive.system1.maxLatency; cognitive.system2.maxRetries; cognitive.router.adaptRate |
| model-policy enforcement | 5 | 2 | 중앙 model-policy 강제 지점; team.md phase-role 기반 model ; 정책 문서 vs config 에이전트 목록 불일치; advisorStrategy; Explore 등 하네스 빌트인/워크플로우 스폰 경 |
| core config/io/cache | 4 | 0 | event-bus subscribe side; event-bus cross-process shar; config flag context.importCa; defaultCache shared singleto |
| swarm | 4 | 1 | HTTP swarm sync via Cloud Ru; Git backend swarm sync at se; '40 uploads' counter display; convergence-detector applyBo |
| learning/grpo reward pipeline | 3 | 2 | GRPO routing trainer episode; episodic.appendEpisode -> ep; Episode payload shape vs rew |
| learning voyager/lifelong/knowledge | 3 | 1 | lifelong-learner; voyager curator; voyager 데이터소스 |
| cognitive routing | 3 | 3 | GRPO learned routing bias re; GRPO routing output; grpoRouting.enabled config f |
| cognitive goal/effort | 3 | 0 | parseGoalIntent; buildGoalSetup + selectEvalu; evaluateHybrid |
| adapters/sdk | 3 | 1 | auto-skill-registrar; GeminiAdapter / CodexAdapter; BaseAdapter |
| autopilot aux | 1 | 0 | smart-skip.js |
| orchestration | 1 | 0 | createCanceler |

## Intentional dormant (29 — NOT to fix, by design)

- learning/grpo reward pipeline: nightly-effort-policy-trainer reads reward-metrics.json (recentEpisodes) as its 
- learning/memory: migrate.js runMigration (legacy -> layered tagging)
- learning core: macro-learner.js approveSuggestion()/rejectSuggestion()
- learning core: self-benchmark.js runSelfBenchmark()
- cognitive routing: effort-policy-config overlay (getEffortPolicyOverlay / getCachedEffortPolicyOver
- cognitive goal/effort: learnedShiftFor + getCachedEffortPolicyOverlay — learned effort band-shift overl
- runtime core: task-budget overlay param (P3 learned budgetMultipliers / effort-policy)
- runtime core: lib/runtime/evaluator.js (runtime eval comparison)
- runtime core: lib/runtime/agent-resolver.js (Phase 2 WS-B.3 agent resolution shim)
- autopilot engine: EVALUATE phase reachability (goalContract-gated routing)
- autopilot aux: mcp-verifier.js (loadAllowList / validateMcpResponse)
- autopilot aux: worktree-manager.js (createWorktree/listWorktrees/removeWorktree)
- autopilot aux: keep-awake (lib/system/keep-awake.js acquireKeepAwake)
- autopilot aux: tui.js (shouldActivateTui / runTuiLoop / renderFrame)
- core hooks/dispatch: hook-dispatcher.js dispatch / loadDispatchTable (generic ordered-handler slot di
- orchestration: agentAsTool / defaultSummarizer (wrap an agent spec as a callable tool spec)
- privacy/visual/system: visual-validator (validateComponent / validatePage / createBaseline) + screensho
- privacy/visual/system: KeepAwakeError (typed error export)
- hooks dispatch wiring: check-console-log.js (legacy Stop hook stub)
- hooks dispatch wiring: PreCompact slot (dispatcher:null, single-hook)
- config flags audit: autopilot.enabled / autopilot.mcp.enabled (and dangerousPatterns, phases, limits
- config flags audit: learning.grpoRouting.{agentPolicy,skillPolicy,jointPolicy,effortPolicy}.enabled
- config flags audit: runtime.longContext.enabled (betaHeader, activationThreshold)
- config flags audit: ux.plainLanguage.enabled / dashboard.enabled
- config flags audit: codex.{mode,pluginPath,defaultModel,timeout,reviewOnStop}
- commands routability: /spec lifecycle command (empty candidates, null default_agent)
- commands routability: /codex command (disable-model-invocation:true, absent from sc router table)
- model-policy enforcement: assemble.md 에이전트 스폰 model 지정
- model-policy enforcement: agent-resolver.js model 필드 노출 (frontmatter model 런타임 해석)

---

## Dormant Reclassification (2026-06-05 follow-up)

Re-verified the 11 WIRE-backlog items the v4.19.1 triage left open — 3 confirmed dormant + 8 `realGap=false` candidates — now with full repo file access (several original verifications ran in a sandbox where the repo was not mounted, so they reported tool failures). Evidence-based dispositions, single source = `.artibot/WIRE-BACKLOG-TRIAGE.md`.

### Confirmed intentional-dormant — formal, no wiring

| WIRE | Capability | Evidence | Why dormant |
|---|---|---|---|
| WIRE-01 | GRPO reward-pipeline emitter (`createRewardMetrics.recordReward`) | `lib/learning/grpo/reward-metrics.js` carries an explicit `DORMANT BY DESIGN` banner; 0 production callers | GRPO CLOSED (v4.19.1). Activation = explicit human decision, not a gap-fix. |
| WIRE-02 | knowledge-transfer `promoteToSystem1` / `bootstrapPromote` | Upstream `hotSwap()` itself has 0 production callers; WIRE-02 is an internal dedup, not a wiring | Wiring leaves dormancy unchanged and breaks `knowledge-demotion-promote.test.js` (spy contract). |
| WIRE-19 | lifecycle middleware config gating (`createLifecycleMiddleware`) | Spec anchors confirmed nonexistent (Glob/Read 0 matches) | Phantom spec — nothing to wire. |

### Reviewed `realGap=false` candidates → 6 dormant · 1 fixed · 1 already-live

| WIRE | Disposition | Evidence (file:line) |
|---|---|---|
| WIRE-05 | **Resolved → removed (B2, 2026-06-20)** | `lib/core/feature-tracker.js` had `createFeatureTracker` with 0 production callers. Wiring rejected: the in-memory event-bus is per-process and runtime `feature:*` emits fire inside short-lived per-prompt hook processes, so session-level aggregation (the tracker's stated purpose) cannot survive process exit. Deleted the subscriber + its 2 theater tests; event-bus doc made honest (fire-and-forget, zero-subscriber = no-op). (= WIRE-10) |
| WIRE-13 | **Dormant** | `lib/core/playbook-registry.js` `listPlaybooks`/`getPlaybook` exported via `index.js` barrel but 0 production consumers; spec remedy = a NEW `scripts/playbook-diag.js` (absent) = feature add, not a wire. |
| WIRE-14 | **Dormant-by-design** | `skill-exporter.js` `exportForGemini/Codex/Cursor` (373/383/393) only re-exported (`lib/core/index.js:39`); shipped `/export` runs `scripts/export-to-tool.mjs`, which does NOT import skill-exporter (node builtins only) = confirmed bypass = parallel library API. |
| WIRE-17 | **Dormant-by-design** | `lib/privacy/token-rotation.js` `generateToken`/`rotateToken` exist; `lib/swarm/swarm-client.js#buildHeaders:160` does not import them; minted tokens are not server-validated = client-only bookkeeping, no auth benefit until a server counterpart exists. |
| WIRE-18 | **Dormant-by-design** | `lib/system/lsp-client.js#collectDiagnostics` + `scripts/hooks/clean-state-check.js` both exist; wiring converts an advisory hook into a per-tool tsc/eslint spawner (~30s/tool) — intentionally kept advisory. |
| WIRE-20 | **Dormant** | `createExtensionRegistry` IS wired into the agent factory (`lib/runtime/create-artibot-agent.js:200,209`), but `discoverExtensions` (`lib/core/extension-loader.js:160`) has 0 callers → registry is consumed via explicit option injection, auto-discovery is a separate unwired feature. Spec "registry write-only" premise refuted. |
| WIRE-21 | **✅ Fixed (realGap=true)** | Reclassified from dormant: triage looked for `lib/swarm/swarm-sync.js` but the file is `scripts/hooks/swarm-sync.js:98-99`, which read non-existent `result.uploadVersion`/`downloadVersion`. `onSessionEnd` returns `{ uploaded, downloaded, version }` (`lib/swarm/sync-scheduler.js:324-330`). Changed both to `result.version` — cosmetic stderr only. |
| WIRE-22 | **Not a gap — already live** | `lib/adapters/adapter-utils.js` `buildSkillFrontmatter:64`/`stripAgentTeamsRefs:131`/`stripClaudeSpecificRefs:155` are consumed by 5 production files (antigravity/codex/cursor/gemini adapters + skill-exporter). Fully wired; close. |

**Net**: dormant list grows by 9 (WIRE-01/02/19 + 05/13/14/17/18/20). WIRE-21 fixed and shipped. WIRE-22 closed as already-live. Remaining `realGap=true` rework backlog: WIRE-09/10/11/15/16.

### Appended to intentional-dormant list (by this follow-up)

- learning/grpo reward pipeline: createRewardMetrics.recordReward (WIRE-01 — DORMANT BY DESIGN banner)
- learning knowledge-transfer: promoteToSystem1 / bootstrapPromote (WIRE-02 — upstream hotSwap dormant)
- runtime middleware: lifecycle config gating createLifecycleMiddleware (WIRE-19 — phantom spec)
- ~~core feature-tracker: createFeatureTracker (WIRE-05/10 — no consumer, no flag)~~ REMOVED (B2, 2026-06-20 — unreachable theater, see WIRE-05)
- core playbook-registry: listPlaybooks / getPlaybook (WIRE-13 — exported, unconsumed)
- core skill-exporter: exportForGemini/Codex/Cursor (WIRE-14 — bypassed by export-to-tool.mjs)
- privacy token-rotation: generateToken / rotateToken (WIRE-17 — client-only, no server validation)
- system lsp-client: collectDiagnostics (WIRE-18 — advisory hook kept advisory)
- core extension auto-discovery: discoverExtensions drain (WIRE-20 — registry wired, discovery unwired)
