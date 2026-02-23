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
  bootstrapLearn,
  updatePatterns,
  getLearningSummary,
  scheduleLearning,
} from './lifelong-learner.js';

// Knowledge Transfer (System 2 -> System 1 promotion/demotion)
export {
  promoteToSystem1,
  bootstrapPromote,
  demoteFromSystem1,
  recordSystem1Usage,
  getPromotionCandidates,
  hotSwap,
  getSystem1Patterns,
  getSystem1Pattern,
  getTransferHistory,
  getTransferStats,
} from './knowledge-transfer.js';

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

/**
 * Process a user message through the conversation-to-memory pipeline.
 * Extracts rules, persists them to memory, and optionally injects
 * them into relevant skill files.
 *
 * @param {string} message - Raw user message text
 * @param {object} [options]
 * @param {string[]} [options.targetSkills] - Skill names to inject into (default: none)
 * @param {string} [options.sessionId] - Current session ID
 * @returns {Promise<{
 *   rulesExtracted: number,
 *   rules: object[],
 *   memorySaved: boolean,
 *   injections: object[]
 * }>}
 */
export async function processUserMessage(message, options = {}) {
  const { targetSkills = [], sessionId } = options;

  const { extractRules: extract } = await import('./rule-extractor.js');
  const rules = extract(message);

  if (rules.length === 0) {
    return { rulesExtracted: 0, rules: [], memorySaved: false, injections: [] };
  }

  // Persist all rules to memory store
  const { saveMemory } = await import('./memory-manager.js');
  let memorySaved = false;
  try {
    for (const rule of rules) {
      await saveMemory('preference', {
        ruleType: rule.type,
        content: rule.content,
        lang: rule.lang,
        confidence: rule.confidence,
        sessionId: sessionId ?? null,
        rawMatch: rule.rawMatch,
      }, {
        tags: [rule.type, rule.lang, 'user-rule', ...rule.content.toLowerCase().split(/\s+/).slice(0, 5)],
        source: 'conversation',
      });
    }
    memorySaved = true;
  } catch (err) {
    process.stderr.write(`[learning] processUserMessage memory save failed: ${err?.message ?? err}\n`);
  }

  // Inject into target skills
  const injections = [];
  if (targetSkills.length > 0) {
    const { injectRules } = await import('./skill-injector.js');
    for (const skillName of targetSkills) {
      try {
        const result = await injectRules(rules, skillName);
        injections.push(result);
      } catch (err) {
        process.stderr.write(`[learning] skill injection failed for ${skillName}: ${err?.message ?? err}\n`);
      }
    }
  }

  return { rulesExtracted: rules.length, rules, memorySaved, injections };
}

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

  const errors = results
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason?.message ?? String(r.reason));

  return { initialized: true, errors: errors.length, errorMessages: errors };
}

/**
 * Build a self-evaluation experience score from the evaluation trend.
 * @param {string} trend - 'improving' | 'declining' | other
 * @returns {number}
 */
function _evalTrendScore(trend) {
  if (trend === 'improving') return 0.8;
  if (trend === 'declining') return 0.3;
  return 0.6;
}

/**
 * Run self-evaluation for the session and collect the experience.
 * @param {object} sessionData - Session context
 * @returns {Promise<object | null>} evaluated result or null on failure
 */
async function _runSelfEvaluation(sessionData) {
  try {
    const { evaluateResult: selfEvaluate, getImprovementSuggestions } = await import('./self-evaluator.js');

    const sessionTask = {
      id: sessionData.sessionId ?? `session-${Date.now()}`,
      type: 'session',
      description: `Session in ${sessionData.project ?? 'unknown'}`,
    };
    const sessionResult = {
      success: (sessionData.errors?.length ?? 0) === 0,
      duration: sessionData.duration ?? undefined,
      testsPass: sessionData.completedTasks?.length > 0 ? true : undefined,
      filesModified: sessionData.filesModified,
    };
    await selfEvaluate(sessionTask, sessionResult);

    const evalResult = await getImprovementSuggestions();

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
      sessionId: sessionData.sessionId,
      score: _evalTrendScore(evalResult.overallTrend),
    });

    return evalResult;
  } catch (err) {
    process.stderr.write(`[learning] self-evaluation failed: ${err?.message ?? err}\n`);
    return null;
  }
}

/**
 * Record a GRPO round from learned patterns.
 * @param {object} learned - Result from batchLearn
 * @returns {Promise<void>}
 */
async function _recordGrpoRound(learned) {
  try {
    const { evaluateGroup: grpoEval, updateWeights: grpoUpdate } = await import('./grpo-optimizer.js');
    const candidates = learned.patterns.map((p, i) => ({
      id: `learn-cand-${Date.now()}-${i}`,
      strategy: p.category ?? 'default',
      result: {
        exitCode: p.bestComposite > 0.5 ? 0 : 1,
        errors: p.bestComposite > 0.5 ? 0 : 1,
        duration: 1000,
        commandLength: 10,
        sideEffects: 0,
      },
    }));
    if (candidates.length >= 2) {
      const groupResult = grpoEval(candidates);
      await grpoUpdate(groupResult);
    }
  } catch (grpoErr) {
    process.stderr.write(`[learning] GRPO recording failed: ${grpoErr?.message ?? grpoErr}\n`);
  }
}

/**
 * Run the lifelong learning pipeline for the session.
 * @param {object} sessionData - Session context
 * @returns {Promise<object | null>} learned result or null on failure
 */
async function _runLifelongLearning(sessionData) {
  try {
    const { collectDailyExperiences: collect, batchLearn: learn } = await import('./lifelong-learner.js');
    await collect(sessionData);
    const learned = await learn();

    if (learned && learned.patternsExtracted > 0) {
      await _recordGrpoRound(learned);
    }

    return learned;
  } catch (err) {
    process.stderr.write(`[learning] lifelong learning pipeline failed: ${err?.message ?? err}\n`);
    return null;
  }
}

/**
 * Run the knowledge hot-swap step.
 * @returns {Promise<object | null>} hot-swap result or null on failure
 */
async function _runHotSwap() {
  try {
    const { hotSwap: swap } = await import('./knowledge-transfer.js');
    return await swap();
  } catch (err) {
    process.stderr.write(`[learning] knowledge hot-swap failed: ${err?.message ?? err}\n`);
    return null;
  }
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
    const { summarizeSession: summarize } = await import('./memory-manager.js');
    await summarize(sessionData);
    summarized = true;

    evaluated = await _runSelfEvaluation(sessionData);
    learned = await _runLifelongLearning(sessionData);
    hotSwapped = await _runHotSwap();
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
  } catch (err) {
    // Non-critical: memory save failure doesn't block the cycle
    process.stderr.write(`[learning] memory save failed for task ${task?.id ?? 'unknown'}: ${err?.message ?? err}\n`);
  }

  return {
    rankings: groupResult.rankings,
    weights,
    evaluation,
    memorySaved,
  };
}
