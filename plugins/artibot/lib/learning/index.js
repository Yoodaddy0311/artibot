/**
 * Learning system barrel file — pure re-exports only.
 * No business logic. All orchestration lives in pipeline.js.
 *
 * Learning loop: experience -> batch learning -> pattern extraction -> System 1 promotion -> faster next time
 * @module lib/learning
 */

// Tool Learner (Toolformer pattern)
export {
  recordUsage,
  suggestTool,
  getToolStats,
  getContextMap,
  pruneOldRecords,
  resetHistory,
  buildContextKey,
} from './tool-learner.js';

// Memory Manager (BlenderBot pattern)
export {
  saveMemory,
  searchMemory,
  getRelevantContext,
  summarizeSession,
  pruneOldMemories,
  loadMemories,
  clearMemories,
  getMemoryStats,
} from './memory-manager.js';

// Self Evaluator (Self-Rewarding pattern)
export {
  evaluateResult,
  getImprovementSuggestions,
  getTeamPerformance,
  getModelPerformance,
  getLearningTrends,
} from './self-evaluator.js';

// Model Identity (effective-model attribution read from session transcripts)
export {
  resolveTranscriptModels,
  toRecordFields,
  pickPrimary,
  emptyAttribution,
} from './model-identity.js';

// Lifelong Learner (Daily experience -> batch learning pipeline)
export {
  collectExperience,
  collectDailyExperiences,
  batchLearn,
  bootstrapLearn,
  updatePatterns,
  getLearningSummary,
  scheduleLearning,
} from './lifelong-learner.js';

// Knowledge Transfer (System 2 -> System 1 promotion)
export {
  promoteToSystem1,
  bootstrapPromote,
  getPromotionCandidates,
  getSystem1Patterns,
  getSystem1Pattern,
  getTransferHistory,
  getTransferStats,
} from './knowledge-transfer.js';

// Knowledge Demotion (System 1 -> System 2 demotion + hot-swap)
export {
  demoteFromSystem1,
  recordSystem1Usage,
  hotSwap,
} from './knowledge-demotion.js';

// Rule Extractor (Conversation-to-Memory pipeline)
export {
  extractRules,
  classifyRule,
  RULE_PATTERNS,
} from './rule-extractor.js';

// Skill Injector (Rule injection into skill SKILL.md files)
export {
  injectRules,
  getInjectedRules,
  clearInjections,
} from './skill-injector.js';

// Drift Detector (Alignment drift monitoring)
export {
  recordScore,
  checkDrift,
  getHistory as getDriftHistory,
  resetAgent,
  resetAll as resetDrift,
  getSummary as getDriftSummary,
} from './drift-detector.js';

// Self-Knowledge Vault (Categorized knowledge persistence)
export {
  addEntry,
  getEntries,
  search as searchVault,
  decay as decayVault,
  getVaultStats,
  resetVault,
  CATEGORIES as VAULT_CATEGORIES,
} from './vault.js';

// Learning Pipeline Orchestration (business logic)
export {
  processUserMessage,
  initLearning,
  shutdownLearning,
} from './pipeline.js';

// Skill Auto-Promotion (Voyager pattern)
export {
  createSkillPromoter,
} from './skill-promoter.js';

// Eval Calibrator (Human feedback → GRPO weight adjustment)
export {
  createEvalCalibrator,
} from './eval-calibrator.js';

// Eval Isolator (Self-evaluation bias separation)
export {
  createEvalIsolator,
} from './eval-isolator.js';

// Skill Freshness Checker (Versioning & staleness detection)
export {
  createSkillFreshnessChecker,
} from './skill-freshness.js';

// Session Memory (Neural TF-IDF vector engine)
export {
  createSessionMemory,
} from './session-memory.js';

// Skill Evolver (Skill evolution engine)
export {
  createSkillEvolver,
  computeMetrics as computeSkillMetrics,
  CLASSIFICATION as SKILL_CLASSIFICATION,
} from './skill-evolver.js';

// Knowledge Graph (Cross-session knowledge graph)
export {
  createKnowledgeGraph,
  NODE_TYPES,
  EDGE_RELATIONS,
} from './knowledge-graph.js';

// Evolution Loop (Self-Evolution Pipeline Orchestrator)
export {
  createEvolutionLoop,
} from './evolution-loop.js';

// Auto Spawn Advisor (next-session suggestion writer)
export {
  analyzeNextSession,
  readPendingSuggestions,
  resolveSuggestion,
} from './auto-spawn-advisor.js';

// Self Benchmark (5-dimension repo scoring)
export {
  runSelfBenchmark,
  computeDimensionScores,
  gatherRepoStats,
} from './self-benchmark.js';

// Macro Learner (prompt sequence → suggested macros)
export {
  observePrompt,
  getMacroSuggestions,
  approveSuggestion,
  rejectSuggestion,
  tryAutoRegister,
  sweepAutoRegister,
} from './macro-learner.js';

// Risk Classifier (diff-level risk scoring)
export {
  classifyDiff,
  scoreFile,
} from './risk-classifier.js';

// Rollback Guard (snapshot / validate / rollback)
export {
  snapshot,
  validateAgainstBaseline,
  rollback,
} from './rollback-guard.js';

// Wakeup Scheduler (AGO Self-Control 7 — marker-only wakeup signal)
export {
  requestWakeup,
  readPendingWakeups,
  fulfillWakeup,
  resetRateLimit,
} from './wakeup-scheduler.js';

// Failure Categorizer (GRPO Stage B — sub-categorize "fix" actions by failure pattern)
export {
  loadFailurePatterns,
  categorizeFailure,
  categorizeAll as categorizeAllFailures,
} from './failure-categorizer.js';
