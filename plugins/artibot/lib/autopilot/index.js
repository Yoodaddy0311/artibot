/**
 * Autopilot module barrel.
 * Re-exports the public surface for engine, safety, generators, store, and notifications.
 *
 * @module lib/autopilot
 */

export {
  startAutopilot,
  resumeAutopilot,
  getStatus,
  abortAutopilot,
  runPhase0Intake,
  runPhase1Plan,
  runPhase2Execute,
  runPhase3CrossCheck,
  runPhase4Verify,
  runPhase5Improve,
  runPhase6Report,
  listActiveWorktrees,
  notePhaseCost,
  buildCostWarningInstruction,
  PHASES,
} from './engine.js';

export {
  getLockPath,
  acquireLock,
  releaseLock,
  releaseAllForSession,
  isLocked,
  readLock,
} from './lock.js';

export {
  getWorktreesRoot,
  getWorktreePath,
  createWorktree,
  removeWorktree,
  listWorktrees,
  pruneOrphans,
} from './worktree-manager.js';

export {
  classifyRisk,
  shouldPause,
  pauseReason,
  parseDuration,
  DANGEROUS_PATTERNS,
} from './safety.js';

export {
  generatePRD,
  renderPRD,
  slugify,
} from './prd-generator.js';

export {
  validateGoalContract,
  HARD_MAX_ITERATIONS,
  DEFAULT_MAX_ITERATIONS,
} from './goal-schema.js';

export {
  parseGoalContract,
} from './prd-parser.js';

export {
  evaluateGoal,
} from './goal-evaluator.js';

export {
  runPhaseGoalEvaluate,
} from './goal-loop.js';

export {
  pauseGoal,
  resumeGoal,
  retryGoal,
  clearGoal,
  getGoalStatus,
} from './goal-control.js';

export {
  generateReport,
  renderReport,
  buildReportData,
} from './report-generator.js';

export {
  loadProfile,
  parseSections,
  parseSimpleYaml,
  mustacheRender,
  assertNoUnfilled,
  capLines,
  renderProfile,
} from './profile-renderer.js';

export {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  newSessionId,
  getSessionPath,
  getStoreDir,
  CURRENT_SCHEMA_VERSION,
  migrateState,
  isLegacyState,
} from './session-store.js';

export {
  notifyCompletion,
  notifyDanger,
  notifyIteration,
  notifyPause,
  notifyPhaseProgress,
  THROTTLE_WINDOW_MS,
} from './notification.js';

export {
  appendEvent,
  readEvents,
  tailEventsStream,
  getEventsPath,
} from './telemetry.js';

export {
  summarizeSession,
  renderTimelineTable,
} from './replay.js';

export {
  diffSession,
  renderDiffTable,
} from './phase-diff.js';

export {
  renderFrame,
  runTuiLoop,
  shouldActivateTui,
} from './tui.js';

export {
  getMemoryDir,
  getFeaturePath,
  extractKey,
  normalizeLesson,
  appendLesson,
  tokenize,
  jaccard,
  scoreLesson,
  recallLessons,
  compactFeature,
} from './memory.js';

export {
  loadAllowList,
  isAllowed,
  wrapInvocation,
  validateMcpResponse,
} from './mcp-verifier.js';

export {
  runPreflight,
  runIndividualCheck,
} from './preflight.js';

export {
  recordPhaseUsage,
  getSessionCost,
  checkBudgetThreshold,
  renderCostBlock,
  renderCostInline,
} from './cost-tracker.js';

// v4.10.0 — Track E: Multi-goal queue & scheduling
export {
  CURRENT_QUEUE_SCHEMA_VERSION,
  GOAL_STATUS,
  dequeueGoal,
  enqueueGoal,
  finalizeGoal,
  getDefaultQueueDir,
  getQueuePath,
  listQueue,
  newQueueId,
  removeFromQueue,
  runQueue,
  setQueuePaused,
} from './goal-queue.js';

export {
  isInWindow,
  nextWindowStart,
  parseWindow,
} from './schedule-window.js';

export {
  classifyComplexity,
  predictCost,
} from './cost-predictor.js';

export {
  CURRENT_BUDGET_SCHEMA_VERSION,
  getBudgetPath,
  getGoalBudget,
  getQueueTotal,
  recordGoalUsage,
} from './goal-budget-aggregator.js';

// v4.10.0 — Track F: Resume granularity & rollback
export {
  rollbackToLastGreen,
  listRollbackTargets,
} from './rollback.js';

export {
  recordSubCheckpoint,
  listSubCheckpoints,
} from './sub-checkpoint.js';

export {
  migrateV2toV3,
  needsV3Migration,
  SCHEMA_VERSION_V3,
  SUPPORTED_FROM_VERSION,
} from './migrate-v3.js';

export {
  computeMachineId,
  recordMachineId,
  detectMachineDrift,
  prepareRebase,
} from './cross-machine.js';

export {
  createDryRunGitRunner,
  wrapPhaseForDryRun,
} from './dry-run.js';

export {
  replayPhase,
} from './phase-replay.js';

// v4.10.0 — Track G: Self-improvement & learning
export {
  SUGGEST_FIX_MIN_COUNT,
  extractErrorSignature,
  clusterFailures,
  suggestFix,
} from './failure-clustering.js';

export {
  COMPLEXITY_LEVELS,
  SKIPPABLE_PHASES,
  classifyTaskComplexity,
  recommendSkippablePhases,
} from './smart-skip.js';

export {
  DEFAULT_SCAN_LIMIT,
  scanRecentSessions,
  extractSuccessPatterns,
  recommendDefaults,
} from './cross-session-learner.js';

export {
  getTemplatesDir,
  loadTemplate,
  listTemplates,
  clearTemplateCache,
} from './template-loader.js';

// v4.10.0 — Track H: Observability & auto-PR
export {
  renderFlamegraph,
} from './flamegraph.js';

export {
  verifyRepoOwnership,
  createAutoPR,
} from './auto-pr.js';

export {
  createEventStream,
  LOCAL_HOST,
} from './dashboard-stream.js';

export {
  extractGoalFields,
  extractPhaseFields,
  computeDrift,
} from './goal-drift-detector.js';

// v4.11.0 — Track J: Engine auto-wiring helpers (silent integration of v4.10.0 features)
export {
  wirePreIntake,
  wireResume,
  wireVerifyFailure,
  wirePhaseEnd,
  wireReport,
} from './auto-wire.js';

export {
  getAutoWirePolicy,
  DEFAULT_AUTOWIRE_POLICY,
  AUTOWIRE_KEYS,
} from './auto-wire-policy.js';

// v4.11.0 — Track K: Failure memory + template auto-suggest
export {
  FAILURE_MEMORY_SCHEMA_VERSION,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_RECALL_LIMIT,
  computeRepoHash,
  getMemoryPath,
  recordFailureMemory,
  recallRelevantFailures,
  pruneOldMemory,
} from './failure-memory.js';

export {
  TEMPLATE_NAMES,
  HISTORY_BOOST,
  suggestTemplate,
  enrichWithTemplate,
  recommendByHistory,
} from './template-suggester.js';

export {
  DEFAULT_SURFACE_THRESHOLD,
  DEFAULT_RENDER_LIMIT,
  shouldSurfaceWarning,
  buildMemoryWarning,
} from './memory-surface.js';
