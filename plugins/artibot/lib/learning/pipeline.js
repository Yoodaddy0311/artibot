/**
 * Learning Pipeline — Business logic orchestration.
 * Contains the high-level learning workflows that coordinate
 * multiple learning subsystems:
 *   - processUserMessage: conversation → memory pipeline
 *   - initLearning: system startup
 *   - shutdownLearning: session-end pipeline
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
import { batchLearn, collectDailyExperiences, collectExperience } from './lifelong-learner.js';
import { toRecordFields } from './model-identity.js';

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
    // Model attribution is resolved upstream (SessionEnd hook reads the
    // transcript). Absent it, rows persist as `modelSource: 'none'` — an
    // explicit "unattributed" beats inferring a model from config, which
    // would look like data while being a guess.
    const modelFields = toRecordFields(sessionData.modelAttribution);
    await evaluateResult(sessionTask, sessionResult, modelFields);

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
        modelSource: modelFields.modelSource,
      },
      model: modelFields.model,
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
        model: modelFields.model,
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
 * Run the lifelong learning pipeline for the session.
 * @param {object} sessionData - Session context
 * @returns {Promise<object | null>} learned result or null on failure
 */
async function runLifelongLearning(sessionData) {
  try {
    await collectDailyExperiences(sessionData);
    const learned = await batchLearn();
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
