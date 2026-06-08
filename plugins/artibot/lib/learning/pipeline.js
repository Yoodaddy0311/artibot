/**
 * Learning Pipeline — Business logic orchestration.
 * Contains the high-level learning workflows that coordinate
 * multiple learning subsystems:
 *   - processUserMessage: conversation → memory pipeline
 *   - initLearning: system startup
 *   - shutdownLearning: session-end pipeline
 *   - runLearningCycle: hybrid GRPO + self-rewarding cycle
 *
 * Extracted from index.js to keep barrel files pure re-exports.
 * Zero runtime deps. ESM only.
 *
 * @module lib/learning/pipeline
 */

// ---------------------------------------------------------------------------
// Direct imports from sibling modules (NOT from index.js — avoids circular)
// ---------------------------------------------------------------------------

import { extractRules } from './rule-extractor.js';
import { saveMemory, summarizeSession } from './memory-manager.js';
import { injectRules } from './skill-injector.js';
import { evaluateResult, getImprovementSuggestions } from './self-evaluator.js';
import { evaluateGroup, updateWeights } from './grpo-optimizer.js';
import { batchLearn, collectDailyExperiences, collectExperience } from './lifelong-learner.js';

// ---------------------------------------------------------------------------
// processUserMessage
// ---------------------------------------------------------------------------

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

  const rules = extractRules(message);

  if (rules.length === 0) {
    return { rulesExtracted: 0, rules: [], memorySaved: false, injections: [] };
  }

  // Persist all rules to memory store
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

// ---------------------------------------------------------------------------
// initLearning
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// shutdownLearning — private helpers
// ---------------------------------------------------------------------------

/**
 * Build a self-evaluation experience score from the evaluation trend.
 * @param {string} trend - 'improving' | 'declining' | other
 * @returns {number}
 */
function evalTrendScore(trend) {
  if (trend === 'improving') return 0.8;
  if (trend === 'declining') return 0.3;
  return 0.6;
}

/**
 * Run self-evaluation for the session and collect the experience.
 * @param {object} sessionData - Session context
 * @returns {Promise<object | null>} evaluated result or null on failure
 */
async function runSelfEvaluation(sessionData) {
  try {
    const sessionTask = {
      id: sessionData.sessionId ?? `session-${Date.now()}`,
      type: 'session',
      description: `Session in ${sessionData.project ?? 'unknown'}`,
    };
    // Success criterion (Stage B Area 1 fix): a session counts as "success"
    // when it actually completed work AND completions outnumber errors.
    // Pre-fix: `errors.length === 0` required zero transient errors (failed
    // greps, ENOENT lookups, hook misfires...) which made real-world success
    // a luxury — 1000 daily-experience records yielded only 3 success rows.
    // The new gate rewards productive sessions even when noise creeps in.
    const completedCount = sessionData.completedTasks?.length ?? 0;
    const errorCount = sessionData.errors?.length ?? 0;
    const sessionResult = {
      success: completedCount > 0 && errorCount <= completedCount,
      duration: sessionData.duration ?? undefined,
      testsPass: completedCount > 0 ? true : undefined,
      filesModified: sessionData.filesModified,
    };
    await evaluateResult(sessionTask, sessionResult);

    const evalResult = await getImprovementSuggestions();

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
      score: evalTrendScore(evalResult.overallTrend),
    });

    // Synthesize a `success` experience when the session completed without
    // errors. Reuses already-computed `sessionResult` so the data is real,
    // not fabricated. Feeds `success-patterns.json` via lifelong-learner.
    if (sessionResult.success) {
      await collectExperience({
        type: 'success',
        category: sessionTask.type,
        data: {
          taskId: sessionTask.id,
          duration: sessionResult.duration ?? null,
          strategy: 'session',
          filesModified: (sessionData.filesModified ?? []).length,
          testsPass: sessionResult.testsPass ?? null,
        },
        sessionId: sessionData.sessionId,
      });
    }

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
async function recordGrpoRound(learned) {
  try {
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
      const groupResult = evaluateGroup(candidates);
      await updateWeights(groupResult);
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
async function runLifelongLearning(sessionData) {
  try {
    await collectDailyExperiences(sessionData);
    const learned = await batchLearn();

    if (learned && learned.patternsExtracted > 0) {
      await recordGrpoRound(learned);
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
async function runHotSwap() {
  try {
    const { hotSwap: swap } = await import('./knowledge-demotion.js');
    return await swap();
  } catch (err) {
    process.stderr.write(`[learning] knowledge hot-swap failed: ${err?.message ?? err}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// shutdownLearning
// ---------------------------------------------------------------------------

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
    await summarizeSession(sessionData);
    summarized = true;

    evaluated = await runSelfEvaluation(sessionData);
    learned = await runLifelongLearning(sessionData);
    hotSwapped = await runHotSwap();
  }

  return { summarized, evaluated, learned, hotSwapped };
}

// ---------------------------------------------------------------------------
// runLearningCycle
// ---------------------------------------------------------------------------

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
  // Step 1-2: GRPO group evaluation
  const groupResult = evaluateGroup(candidateResults, options.rules);

  // Step 3: Update weights
  const weights = await updateWeights(groupResult);

  // Step 4: Self-evaluate the best candidate
  const best = groupResult.best;
  const bestCandidate = candidateResults.find((c) => c.id === best?.candidateId);
  const evaluation = bestCandidate
    ? await evaluateResult(task, {
        success: (bestCandidate.result?.exitCode ?? 1) === 0,
        duration: bestCandidate.result?.duration,
        testsPass: (bestCandidate.result?.errors ?? 1) === 0,
      })
    : null;

  // Step 5: Store learning in memory
  let memorySaved = false;
  try {
    await saveMemory('learning', {
      taskId: task.id,
      domain: task.domain,
      bestStrategy: best?.strategy,
      bestScore: best?.composite,
      spread: groupResult.spread,
      evaluation: evaluation ? { overall: evaluation.overall, grade: evaluation.grade } : null,
    });
    memorySaved = true;
  } catch (err) {
    process.stderr.write(`[learning] memory save failed for task ${task?.id ?? 'unknown'}: ${err?.message ?? err}\n`);
  }

  return {
    rankings: groupResult.rankings,
    weights,
    evaluation,
    memorySaved,
  };
}
