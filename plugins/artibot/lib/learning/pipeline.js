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
import { emptySignals } from './session-signals.js';

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
 * Ceiling on a session's tool-error rate for it to count as a success.
 *
 * Deliberately placed *outside* the observed error-rate distribution, not
 * inside it. Measured over all 92 tool-using transcripts under
 * `~/.claude/projects` (2026-08-10T01:22Z): median 1.94%, p75 2.87%, p90 4.00%,
 * with 13% of sessions at exactly zero errors.
 *
 * Two measurements drove the placement:
 *
 *   Stability — moving the ceiling by one percentage point near the middle of
 *   the distribution re-labels a large slice of the corpus (2%->3% flips 18
 *   sessions, 3%->4% flips 13), while anywhere in 20%–30% flips none. A
 *   boundary whose verdict is insensitive to its own exact value is one that
 *   can be defended later.
 *
 *   Separability — of the 73 sessions between 0.5% and 8%, 38 have a Wilson 95%
 *   interval that *contains* 3%. Cutting there would assign success and failure
 *   on differences indistinguishable from sampling noise, and every dimension
 *   downstream of `success` would inherit that noise while looking like signal.
 *
 * So this is a liveness test, not a quality verdict: it separates a session that
 * did some work that worked from one that essentially only failed (the two it
 * catches ran 1/1 and 3/9 calls). Judging whether the work was *good* needs a
 * signal no transcript carries.
 */
const SESSION_ERROR_RATE_CEILING = 0.25;

/**
 * Turn transcript signals into the result object the self-evaluator scores.
 *
 * `testsPass` is deliberately never set. No transcript signal reports a test
 * command's exit code, and the code this replaces manufactured one from the
 * same count that produced `success` — two dimensions moving in lockstep off a
 * single input, which is half of why the grades were constant. `undefined` is
 * the honest answer and `inputsPresent.testsPass: false` records it.
 *
 * `duration` is deliberately not set either, which **diverges from PRD §5.3**
 * (it specifies `duration <- wallClockMs`). Measured over all 92 tool-using
 * transcripts (2026-08-10T01:22Z): 8 sessions engage no files, so the efficiency
 * ratio has no denominator and `scoreEfficiency` falls through to the rubric v1
 * duration ladder — where 6 of those 8 land past the `<300s` floor and score 1.
 * They are 1-to-9-call sessions that merely sat open a long time, and
 * self-evaluator.js:480-482 deliberately returns no ratio for them precisely
 * because that is missing information, not infinite inefficiency. Supplying
 * `duration` reinstates the collapse through the back door.
 *
 * The fallback also buys nothing: the ratio axis alone already produces all five
 * scores across the other 84 sessions ({5:44, 4:22, 3:5, 2:8, 1:5}), so dropping
 * duration costs zero variance and removes 6 wrong verdicts. Wall-clock is still
 * recorded on the success-experience row — it is useful data, just not an
 * efficiency score.
 *
 * Exported for tests: the acceptance criterion is that scores vary across real
 * transcripts, and a test that rebuilt this mapping locally would be checking
 * its own copy rather than the wiring that ships.
 *
 * @param {object} signals - Record from resolveSessionSignals()
 * @returns {object} `result` accepted by evaluateResult()
 */
export function buildSessionResult(signals) {
  if (signals.source !== 'transcript') {
    // Nothing was measured. Every field stays absent so `inputsPresent` reads
    // false across the board: the record says "unmeasured" rather than passing
    // off `emptySignals()`'s zeros as an observation of an idle session.
    return { success: undefined, testsPass: undefined };
  }
  return {
    success: signals.toolCalls > 0
      ? signals.toolErrors / signals.toolCalls <= SESSION_ERROR_RATE_CEILING
      : undefined,
    testsPass: undefined,
    toolCalls: signals.toolCalls,
    // Both counts or neither: `scoreAccuracy` forms a failure *rate* from the
    // pair (scoring.js#toolErrorRate) and falls back to the boolean `success`
    // when either is missing — which collapsed accuracy onto one value for 90 of
    // 92 sessions, since `success` is true for nearly all of them.
    toolErrors: signals.toolErrors,
    // filesSeen -> filesEngaged, filesTouched -> filesModified. These are not
    // interchangeable: `filesEngaged` is the efficiency denominator and the
    // ladder was tuned against both series (self-evaluator.js:43-55), where the
    // same boundaries yield 4 distinct scores on filesSeen and 3 on
    // filesTouched. Feeding the wrong one shifts every ratio by ~2x.
    filesEngaged: signals.filesSeen,
    filesModified: signals.filesTouched,
  };
}

/**
 * Record the self-evaluation experience for the session.
 * @param {object} evalResult - Output of getImprovementSuggestions()
 * @param {object} sessionData - Session context
 * @param {object} modelFields - Model attribution record fields
 * @returns {Promise<void>}
 */
async function recordEvaluationExperience(evalResult, sessionData, modelFields) {
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
}

/**
 * Synthesize a `success` experience when the session's error rate stayed under
 * {@link SESSION_ERROR_RATE_CEILING}. Reuses the already-scored `sessionResult`
 * so the row carries measured values rather than a second derivation. Feeds
 * `success-patterns.json` via lifelong-learner. No-ops when the session did not
 * succeed, or when success could not be measured at all.
 *
 * @param {object} args
 * @param {object} args.sessionTask - Task descriptor for the session
 * @param {object} args.sessionResult - Scoring inputs from buildSessionResult()
 * @param {object} args.modelFields - Model attribution record fields
 * @param {string} [args.sessionId] - Session identifier
 * @param {number|null} [args.wallClockMs] - Session span. Taken from the signals
 *   rather than `sessionResult`, which no longer carries a duration: wall-clock
 *   is worth recording but must not reach `scoreEfficiency` (see
 *   {@link buildSessionResult}).
 * @returns {Promise<void>}
 */
async function recordSuccessExperience({
  sessionTask, sessionResult, modelFields, sessionId, wallClockMs,
}) {
  if (!sessionResult.success) return;
  await collectExperience({
    type: 'success',
    category: sessionTask.type,
    data: {
      taskId: sessionTask.id,
      duration: wallClockMs ?? null,
      strategy: 'session',
      // Reads the scored result, not `sessionData.filesModified` — that key
      // never existed on the payload, so this recorded a constant 0.
      filesModified: sessionResult.filesModified ?? null,
      testsPass: sessionResult.testsPass ?? null,
    },
    model: modelFields.model,
    sessionId,
  });
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
    // Scoring inputs come from the transcript, not from `completedTasks`.
    // That field is absent from every real SessionEnd payload, so the previous
    // criterion evaluated to false forever and collapsed 500 records into two
    // distinct grades. `completedTasks` still rides along in sessionData for
    // the other consumers; what changed is that scoring no longer depends on a
    // field nothing populates.
    const signals = sessionData.signals ?? emptySignals();
    const sessionResult = buildSessionResult(signals);
    // Model attribution is resolved upstream (SessionEnd hook reads the
    // transcript). Absent it, rows persist as `modelSource: 'none'` — an
    // explicit "unattributed" beats inferring a model from config, which
    // would look like data while being a guess.
    const modelFields = toRecordFields(sessionData.modelAttribution);
    await evaluateResult(sessionTask, sessionResult, {
      ...modelFields,
      signalSource: signals.source,
    });

    const evalResult = await getImprovementSuggestions();

    await recordEvaluationExperience(evalResult, sessionData, modelFields);
    await recordSuccessExperience({
      sessionTask,
      sessionResult,
      modelFields,
      sessionId: sessionData.sessionId,
      wallClockMs: signals.wallClockMs,
    });

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
 * Supply the session summary with counts it can otherwise only get from an
 * event `history` — which the SessionEnd payload has never carried, leaving
 * every stored summary at `commandCount: 0, errorCount: 0, duration: null`.
 *
 * Written as metadata rather than a synthesized `history`: the transcript gives
 * how many tools ran, not which commands they were, and inventing history
 * entries to carry a count would put fabricated events in the memory store.
 * Unmeasured sessions are left alone so the summary keeps saying "nothing
 * recorded" instead of asserting a measured zero.
 *
 * @param {object} sessionData - Session context, possibly carrying `signals`
 * @returns {object} sessionData with measured counts merged into `metadata`
 */
function withMeasuredMetadata(sessionData) {
  const signals = sessionData.signals;
  if (signals?.source !== 'transcript') return sessionData;
  return {
    ...sessionData,
    metadata: {
      commandCount: signals.toolCalls,
      errorCount: signals.toolErrors,
      duration: signals.wallClockMs ?? null,
      ...sessionData.metadata,
    },
  };
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
    await summarizeSession(withMeasuredMetadata(sessionData));
    summarized = true;

    evaluated = await runSelfEvaluation(sessionData);
    learned = await runLifelongLearning(sessionData);
    hotSwapped = await runHotSwap();
  }

  return { summarized, evaluated, learned, hotSwapped };
}
