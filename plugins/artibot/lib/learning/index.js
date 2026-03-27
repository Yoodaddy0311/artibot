/**
 * Learning system barrel file — pure re-exports only.
 * No business logic. All orchestration lives in pipeline.js.
 *
 * Learning loop: experience -> batch GRPO -> pattern extraction -> System 1 promotion -> faster next time
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
  getLearningTrends,
} from './self-evaluator.js';

// GRPO Optimizer (Group Relative Policy Optimization)
export {
  generateCandidates,
  evaluateGroup,
  updateWeights,
  generateTeamCandidates,
  evaluateTeamGroup,
  updateTeamWeights,
  getRecommendation,
  getGrpoStats,
  CLI_RULES,
  TEAM_EVALUATION_RULES,
} from './grpo-optimizer.js';

// Lifelong Learner (Daily experience -> GRPO batch learning pipeline)
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

// Auto-Learning Pipeline Runner
export {
  runAutoLearningPipeline,
  loadAutoLearningConfig,
  validateConfig as validateAutoLearningConfig,
  runSelfScan,
  runPatternExtract,
  runKnowledgeUpdate,
  runSkillRefinement,
  runAutoCommit,
  checkBranchSafety,
  countChanges,
  collectProvenance,
  stripProvenancePII,
} from './auto-learning-runner.js';

// Learning Pipeline Orchestration (business logic)
export {
  processUserMessage,
  initLearning,
  shutdownLearning,
  runLearningCycle,
} from './pipeline.js';

// Skill Auto-Promotion (Voyager pattern)
export {
  createSkillPromoter,
} from './skill-promoter.js';

// Eval Calibrator (Human feedback → GRPO weight adjustment)
export {
  createEvalCalibrator,
} from './eval-calibrator.js';
