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
