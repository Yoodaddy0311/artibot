/**
 * Learning system module re-exports.
 * Integrates six learning subsystems (hybrid architecture):
 *   - tool-learner: Toolformer-inspired tool selection learning
 *   - memory-manager: BlenderBot-inspired long-term memory + RAG
 *   - self-evaluator: Meta Self-Rewarding evaluation loop
 *   - grpo-optimizer: Group Relative Policy Optimization (rule-based self-learning)
 *   - lifelong-learner: Daily experience collection + GRPO batch learning pipeline
 *   - knowledge-transfer: System 2 -> System 1 pattern promotion/demotion
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
  updatePatterns,
  getLearningSummary,
  scheduleLearning,
} from './lifelong-learner.js';

// Knowledge Transfer (System 2 -> System 1 promotion/demotion)
export {
  promoteToSystem1,
  demoteFromSystem1,
  recordSystem1Usage,
  getPromotionCandidates,
  hotSwap,
  getSystem1Patterns,
  getSystem1Pattern,
  getTransferHistory,
  getTransferStats,
} from './knowledge-transfer.js';

/**
 * Initialize all learning subsystems.
 * Prunes stale data from tool history and memory stores.
 * Call once at plugin startup.
 */
export async function initLearning() {
  const results = await Promise.allSettled([
    import('./tool-learner.js').then((m) => m.pruneOldRecords()),
    import('./memory-manager.js').then((m) => m.pruneOldMemories()),
  ]);

  const errors = results.filter((r) => r.status === 'rejected');
  if (errors.length > 0) {
    for (const err of errors) {
      console.error('[learning] init error:', err.reason?.message ?? err.reason);
    }
  }

  return { initialized: true, errors: errors.length };
}

/**
 * Graceful shutdown: persist any pending state, summarize session,
 * run self-evaluation, run lifelong learning, and promote eligible patterns to System 1.
 * Call at plugin teardown.
 * @param {object} [sessionData] - Optional session context for summarization
 * @returns {Promise<{ summarized: boolean, evaluated: object | null, learned: object | null, hotSwapped: object | null }>}
 */
export async function shutdownLearning(sessionData) {
  let summarized = false;
  let evaluated = null;
  let learned = null;
  let hotSwapped = null;

  if (sessionData) {
    // Summarize session in memory
    const { summarizeSession: summarize } = await import('./memory-manager.js');
    await summarize(sessionData);
    summarized = true;

    // Self-evaluation: assess session quality and collect as experience
    try {
      const { getImprovementSuggestions } = await import('./self-evaluator.js');
      const evalResult = await getImprovementSuggestions();
      evaluated = evalResult;

      // Feed evaluation result into lifelong learning as a self-evaluation experience
      const { collectExperience } = await import('./lifelong-learner.js');
      await collectExperience({
        type: 'self-evaluation',
        category: 'session',
        data: {
          overallTrend: evalResult.overallTrend,
          weakDimensions: evalResult.weakDimensions,
          suggestions: evalResult.suggestions,
          sessionId: sessionData.sessionId,
          project: sessionData.project,
        },
        score: evalResult.overallTrend === 'improving' ? 0.8
          : evalResult.overallTrend === 'declining' ? 0.3
          : 0.6,
      });
    } catch {
      // Non-critical: evaluation failure doesn't block shutdown
    }

    // Run lifelong learning pipeline
    try {
      const { collectDailyExperiences: collect, batchLearn: learn } = await import('./lifelong-learner.js');
      await collect(sessionData);
      learned = await learn();
    } catch {
      // Non-critical: learning failure doesn't block shutdown
    }

    // Hot-swap: promote/demote patterns based on latest learning
    try {
      const { hotSwap: swap } = await import('./knowledge-transfer.js');
      hotSwapped = await swap();
    } catch {
      // Non-critical
    }
  }

  return { summarized, evaluated, learned, hotSwapped };
}

/**
 * Execute a full hybrid learning cycle:
 *   1. Generate candidates (GRPO)
 *   2. Evaluate group with rules (GRPO)
 *   3. Update strategy weights (GRPO)
 *   4. Evaluate best result (Self-Rewarding)
 *   5. Store insights in memory (BlenderBot)
 *
 * @param {object} task - { id, type, description, domain }
 * @param {object[]} candidateResults - Array of { ...candidate, result: { exitCode, errors, duration, ... } }
 * @param {object} [options]
 * @param {object} [options.rules] - Custom evaluation rules
 * @returns {Promise<{ rankings: object[], weights: object, evaluation: object, memorySaved: boolean }>}
 */
export async function runLearningCycle(task, candidateResults, options = {}) {
  const { evaluateGroup: grpoEvaluate, updateWeights: grpoUpdateWeights } = await import('./grpo-optimizer.js');
  const { evaluateResult: selfEvaluate } = await import('./self-evaluator.js');
  const { saveMemory: memSave } = await import('./memory-manager.js');

  // Step 1-2: GRPO group evaluation
  const groupResult = grpoEvaluate(candidateResults, options.rules);

  // Step 3: Update weights
  const weights = await grpoUpdateWeights(groupResult);

  // Step 4: Self-evaluate the best candidate
  const best = groupResult.best;
  const bestCandidate = candidateResults.find((c) => c.id === best?.candidateId);
  const evaluation = bestCandidate
    ? await selfEvaluate(task, {
        success: (bestCandidate.result?.exitCode ?? 1) === 0,
        duration: bestCandidate.result?.duration,
        testsPass: (bestCandidate.result?.errors ?? 1) === 0,
      })
    : null;

  // Step 5: Store learning in memory
  let memorySaved = false;
  try {
    await memSave('learning', {
      taskId: task.id,
      domain: task.domain,
      bestStrategy: best?.strategy,
      bestScore: best?.composite,
      spread: groupResult.spread,
      evaluation: evaluation ? { overall: evaluation.overall, grade: evaluation.grade } : null,
    });
    memorySaved = true;
  } catch {
    // Non-critical: memory save failure doesn't block the cycle
  }

  return {
    rankings: groupResult.rankings,
    weights,
    evaluation,
    memorySaved,
  };
}
