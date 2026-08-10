#!/usr/bin/env node
/**
 * SessionEnd hook.
 * Saves current session state to ~/.claude/artibot-state.json
 * and runs the learning pipeline with parallelized independent stages.
 *
 * Pipeline: delegates to shutdownLearning() which handles the full cycle:
 *   1. summarizeSession (memory)
 *   2. self-evaluation (evaluateResult + collectExperience)
 *   3. experience collection + batch learning
 *   4. knowledge transfer hot-swap
 */

import { atomicWriteSync, getPluginRoot, parseJSON, readStdin, toFileUrl } from '../utils/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createErrorHandler, getStatePath, logHookError } from '../../lib/core/hook-utils.js';

/**
 * Run the learning pipeline using shutdownLearning() which includes:
 *   1. Session summarization (memory)
 *   2. Self-evaluation (evaluateResult via getImprovementSuggestions + collectExperience)
 *   3. Experience collection + batch learning (collectDailyExperiences + batchLearn)
 *   4. Knowledge transfer hot-swap (hotSwap - no args, reads patterns internally)
 *
 * @param {object} sessionData - Session context data
 * @param {object} learningModule - The imported learning module
 * @returns {Promise<{ summarized: boolean, evaluated: object|null, learned: object|null, hotSwapped: object|null }>}
 */
export async function runLearningPipeline(sessionData, learningModule) {
  const { shutdownLearning } = learningModule;
  return shutdownLearning(sessionData);
}

/**
 * Read the Artibot config JSON best-effort. Returns `{}` on any failure so
 * callers can safely destructure without defensive checks.
 * @returns {Promise<object>}
 */
async function readArtibotConfig() {
  try {
    const { readFileSync } = await import('node:fs');
    const cfgPath = path.join(getPluginRoot(), 'artibot.config.json');
    return JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Emit the one-shot first-run welcome message (observe mode only).
 * Writes `welcomedAt` into the first-run state file so the message never
 * repeats. No-ops when firstRunMode is disabled or we've already welcomed.
 */
async function maybeEmitFirstRunWelcome() {
  const cfg = await readArtibotConfig();
  if (cfg?.ago?.selfControl?.firstRunMode?.enabled === false) return;

  const firstRunModPath = path.join(getPluginRoot(), 'lib', 'learning', 'first-run-guard.js');
  const { getFirstRunState, _internals } = await import(toFileUrl(firstRunModPath));
  const st = await getFirstRunState(cfg);
  if (st.mode !== 'observe') return;

  const frStatePath = _internals.resolveStatePath(cfg);
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
  let raw = {};
  try {
    if (existsSync(frStatePath)) raw = JSON.parse(readFileSync(frStatePath, 'utf-8'));
  } catch { /* treat as fresh */ }
  if (raw.welcomedAt) return;

  process.stderr.write(
    `[artibot:welcome — 자가 관리 엔진이 관찰 모드로 시작되었어요. ${st.runsRemaining}회 후 자동으로 활성화됩니다. 끄고 싶으면 artibot.config.json에서 masterEnabled: false로 바꾸세요.]\n`,
  );
  raw.welcomedAt = new Date().toISOString();
  try { writeFileSync(frStatePath, JSON.stringify(raw, null, 2) + '\n', 'utf-8'); } catch { /* ignore */ }
}

/**
 * Persist the session-end state snapshot atomically.
 * @param {object} hookData
 */
function saveSessionState(hookData) {
  const statePath = getStatePath();
  const state = {
    sessionId: hookData?.session_id || null,
    endedAt: new Date().toISOString(),
    startedAt: hookData?.started_at || null,
    cwd: process.cwd(),
    metadata: {
      platform: process.platform,
      nodeVersion: process.version,
    },
  };
  try {
    atomicWriteSync(statePath, state);
  } catch (err) {
    logHookError('session-end', 'Failed to save state', err);
  }
}

/**
 * Resolve which model actually served this session by reading the transcript
 * the hook payload points at. Returns an unattributed record on any failure —
 * model attribution is telemetry, never a reason to fail SessionEnd.
 *
 * @param {object} hookData
 * @returns {Promise<object>} attribution from lib/learning/model-identity.js
 */
async function resolveModelAttribution(hookData) {
  try {
    const modelIdPath = path.join(
      getPluginRoot(), 'lib', 'learning', 'model-identity.js',
    );
    const mod = await import(toFileUrl(modelIdPath));
    const attribution = await mod.resolveTranscriptModels(hookData?.transcript_path);
    // Surfaced on stderr like the learning summary: a silent 'none' is the
    // failure mode that would otherwise leave every row unattributed forever.
    const subag = attribution.sidechainTurns ?? 0;
    process.stderr.write(
      `[learning] model attribution: ${attribution.primary ?? 'none'} `
      + `(source=${attribution.source}, turns=${attribution.turns}`
      + `[main ${attribution.turns - subag}/subag ${subag}])\n`,
    );
    return attribution;
  } catch (err) {
    logHookError('session-end', 'model attribution failed', err);
    process.stderr.write(`[learning] model attribution failed: ${err?.message ?? err}\n`);
    return null;
  }
}

/**
 * Read what actually happened this session out of the transcript: how many
 * tools ran, how many failed, how many files were touched, how long it spanned.
 *
 * Same discipline as {@link resolveModelAttribution}: instrumentation never
 * fails SessionEnd. A null return means "could not measure", which the pipeline
 * turns into absent inputs rather than zeros — the whole point of this work is
 * that "measured nothing" and "failed to measure" must stay distinguishable.
 *
 * The transcript path comes from the hook payload only. Assembling a guess from
 * the session id would silently score the wrong file.
 *
 * @param {object} hookData
 * @returns {Promise<object|null>} signals from lib/learning/session-signals.js
 */
async function resolveSessionSignals(hookData) {
  try {
    const signalsPath = path.join(
      getPluginRoot(), 'lib', 'learning', 'session-signals.js',
    );
    const mod = await import(toFileUrl(signalsPath));
    const signals = await mod.resolveSessionSignals(hookData?.transcript_path);
    // Surfaced for the same reason as model attribution: a silent 'none' is how
    // this pipe broke last time and stayed broken for 500 records.
    process.stderr.write(
      `[learning] session signals: source=${signals.source}, `
      + `tools=${signals.toolCalls} (errors ${signals.toolErrors}), `
      + `files=${signals.filesTouched} touched/${signals.filesSeen} seen\n`,
    );
    return signals;
  } catch (err) {
    logHookError('session-end', 'session signal extraction failed', err);
    process.stderr.write(`[learning] session signals failed: ${err?.message ?? err}\n`);
    return null;
  }
}

/**
 * Extract the session data payload consumed by shutdownLearning().
 *
 * Exported for tests: this is the seam where measurement enters the learning
 * pipeline, and it went unnoticed for 500 records that nothing was arriving.
 *
 * @param {object} hookData
 * @returns {Promise<object>}
 */
export async function buildSessionData(hookData) {
  return {
    sessionId: hookData.session_id || `session-${Date.now()}`,
    toolUsage: hookData.tool_usage || {},
    errors: hookData.errors || [],
    // Kept even though the payload never populates it: a future schema may, and
    // `inputsPresent.success` now records whether it actually arrived. What
    // changed is that scoring no longer *depends* on it — that was the bug.
    completedTasks: hookData.completed_tasks || [],
    teamConfig: hookData.team_config || null,
    modelAttribution: await resolveModelAttribution(hookData),
    signals: await resolveSessionSignals(hookData),
  };
}

/**
 * Compose the stderr summary line for the learning pipeline result.
 * @param {object} result
 * @returns {string}
 */
function formatLearningSummary(result) {
  const parts = ['[learning] SessionEnd pipeline complete (shutdownLearning)'];
  if (result.summarized) parts.push('summarized');
  if (result.evaluated) parts.push('evaluated');
  if (result.learned) {
    parts.push(`groups: ${result.learned.groupsProcessed ?? 0}`);
    parts.push(`patterns: ${result.learned.patternsExtracted ?? 0}`);
  }
  if (result.hotSwapped) {
    parts.push(`promoted: ${result.hotSwapped.promoted?.length ?? 0}`);
    parts.push(`demoted: ${result.hotSwapped.demoted?.length ?? 0}`);
  }
  return parts.join(' | ');
}

/**
 * Run the shutdownLearning pipeline and log its summary. Never throws —
 * failures are logged via logHookError so session-end always completes.
 *
 * @param {object} sessionData
 */
async function runLearningStage(sessionData) {
  try {
    const pluginRoot = getPluginRoot();
    const learningPath = path.join(pluginRoot, 'lib', 'learning', 'index.js');
    const learningModule = await import(toFileUrl(learningPath));
    const result = await runLearningPipeline(sessionData, learningModule);
    process.stderr.write(`${formatLearningSummary(result)}\n`);
  } catch (err) {
    logHookError('session-end', 'learning pipeline failed', err);
  }
}

/**
 * Compose the stderr line for a score-health verdict.
 *
 * `unmeasured` rides along with `degenerate` on purpose: a store can flatten
 * because scoring broke, or because the signals stopped arriving, and those call
 * for opposite responses. Reporting only the collapse would leave the reader
 * guessing which one they are looking at.
 *
 * @param {object} health - Result of getScoreHealth()
 * @returns {string}
 */
function formatScoreHealth(health) {
  const verdict = health.degenerate
    ? `DEGENERATE — ${health.reason}`
    : (health.reason ?? 'ok');
  // `unmeasured` counts rows; `absent` counts dimensions. A rubric can be half
  // dark with every row measured, and reporting a bare "ok" over that is the
  // same silence this line exists to break.
  const absent = health.absentDimensions?.length
    ? `, absent=${health.absentDimensions.join('·')}`
    : '';
  return `[learning] score health: ${verdict} `
    + `(samples=${health.samples}, unmeasured=${health.unmeasured}${absent}, `
    + `signatures=${health.distinctSignatures}, rubric v${health.rubricVersion})`;
}

/**
 * Surface the evaluation store's degeneracy verdict on stderr, next to the
 * signal and attribution lines a human already reads at session end.
 *
 * This is the third leg of the anti-regression defence. `source:'none'` reports
 * that one session went unmeasured and `inputsPresent` records which signals
 * arrived, but neither notices a store that has been emitting the same row for
 * weeks — which is exactly what happened for 318 consecutive rows. A verdict
 * nobody prints is a verdict nobody acts on.
 *
 * Read-only: getScoreHealth() calls loadEvaluations() -> readJsonFile() and
 * writes nothing, so running it every session cannot corrupt the store it
 * inspects.
 *
 * @param {object} [deps] - Injection seam for tests
 * @param {Function} [deps.getScoreHealth] - Override the health reader
 * @param {string} [deps.pluginRoot] - Override the module search root
 * @returns {Promise<void>}
 */
export async function reportScoreHealth(deps = {}) {
  try {
    let read = deps.getScoreHealth;
    if (!read) {
      const healthPath = path.join(
        deps.pluginRoot || getPluginRoot(), 'lib', 'learning', 'score-health.js',
      );
      read = (await import(toFileUrl(healthPath))).getScoreHealth;
    }
    process.stderr.write(`${formatScoreHealth(await read())}\n`);
  } catch (err) {
    logHookError('session-end', 'score health check failed', err);
  }
}

/**
 * Read the swarm hub configuration from artibot.config.json. Returns safe
 * defaults when the file is missing or unreadable (optIn defaults to false).
 * @returns {Promise<{ optIn: boolean, minSuccessRate: number, minUsageCount: number }>}
 */
async function readHubConfig() {
  const hubConfig = { optIn: false, minSuccessRate: 0.6, minUsageCount: 5 };
  try {
    const plugRoot = getPluginRoot();
    const configPath = path.join(plugRoot, 'artibot.config.json');
    const { readFileSync } = await import('node:fs');
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (cfg.swarm) {
      return {
        optIn: Boolean(cfg.swarm.optIn && cfg.swarm.enabled),
        minSuccessRate: cfg.swarm.minSuccessRate ?? 0.6,
        minUsageCount: cfg.swarm.minUsageCount ?? 5,
      };
    }
  } catch {
    // Fall through to defaults
  }
  return hubConfig;
}

/**
 * Self-Evolution Loop: compress → knowledge-graph → skill-evolver →
 * auto-research → contribute. All stage-level errors are logged but never
 * re-thrown so the hook stays non-blocking.
 *
 * @param {object} hookData
 */
async function runEvolutionLoop(hookData) {
  try {
    const plugRoot = getPluginRoot();
    const evolutionPath = path.join(plugRoot, 'lib', 'learning', 'evolution-loop.js');
    const { createEvolutionLoop } = await import(toFileUrl(evolutionPath));
    const hubConfig = await readHubConfig();

    // Layer-3 evolution-loop cannot import Layer-4 cognitive; wire autoResearch here.
    const autoResearchPath = path.join(plugRoot, 'lib', 'cognitive', 'auto-research.js');
    const { createAutoResearch } = await import(toFileUrl(autoResearchPath));
    const autoResearch = createAutoResearch();

    const loop = createEvolutionLoop({ hubConfig, autoResearch });
    const evolutionResult = await loop.run({
      events: hookData.events || [],
      skillUsages: hookData.skill_usages || [],
      routingResult: hookData.routing_result || null,
    });

    if (evolutionResult.errors.length > 0) {
      for (const err of evolutionResult.errors) {
        logHookError('session-end', `evolution-loop ${err.stage}: ${err.message}`);
      }
    }
  } catch (err) {
    logHookError('session-end', `evolution-loop failed: ${err.message || err}`);
  }
}

/**
 * AGO Track G6: auto-spawn advisor (next-session suggestions). Opt-in,
 * write-only, never executes or schedules anything. Failure is graceful
 * — must never block session-end.
 *
 * @param {object} hookData
 */
async function runAutoSpawnAdvisor(hookData) {
  try {
    const plugRoot = getPluginRoot();
    const advisorPath = path.join(plugRoot, 'lib', 'learning', 'auto-spawn-advisor.js');
    const cfgPath = path.join(plugRoot, 'artibot.config.json');
    const { analyzeNextSession } = await import(toFileUrl(advisorPath));

    let agoConfig = {};
    try {
      const { readFileSync } = await import('node:fs');
      agoConfig = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    } catch {
      // Missing/unreadable config → advisor treats as opt-in=false
    }

    const advisorSummary = {
      unresolvedTodos: Array.isArray(hookData.unresolved_todos) ? hookData.unresolved_todos : [],
      testFailures: Array.isArray(hookData.test_failures) ? hookData.test_failures : [],
      driftWarnings: Array.isArray(hookData.drift_warnings) ? hookData.drift_warnings : [],
      staleSkills: Array.isArray(hookData.stale_skills) ? hookData.stale_skills : [],
      learningIncomplete: hookData.learning_incomplete ?? null,
    };

    const advisorResult = await analyzeNextSession(advisorSummary, {
      pluginRoot: plugRoot,
      config: agoConfig,
    });
    if (advisorResult.written) {
      process.stderr.write(
        `[artibot] auto-spawn-advisor: ${advisorResult.suggestions.length} suggestion(s) written\n`,
      );
    }
  } catch (err) {
    logHookError('session-end', `auto-spawn-advisor failed: ${err.message || err}`);
  }
}

/**
 * Run the full advisor chain: first-run welcome, auto-spawn advisor, and
 * macro auto-register sweep. Each stage is isolated with try/catch so a
 * failure in one never blocks the others.
 *
 * @param {object} hookData
 */
async function runAdvisors(hookData) {
  try {
    await maybeEmitFirstRunWelcome();
  } catch (err) {
    logHookError('session-end', `first-run welcome skipped: ${err.message || err}`);
  }

  await runAutoSpawnAdvisor(hookData);

  try {
    await runMacroAutoRegister();
  } catch (err) {
    logHookError('session-end', `macro-auto-register failed: ${err.message || err}`);
  }
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  saveSessionState(hookData);

  if (!hookData) return;

  const sessionData = await buildSessionData(hookData);
  await runLearningStage(sessionData);
  // After the pipeline persists this session's row, so the verdict reflects the
  // store the user is about to walk away from rather than its previous state.
  await reportScoreHealth();
  await runEvolutionLoop(hookData);
  await runAdvisors(hookData);
}

/**
 * Load macro-learner and sweep pending suggestions. Reads config fresh to
 * respect user edits made during the session. Runs the sweep unconditionally
 * (the macro-learner enforces gates itself) so the hook stays one-line simple.
 *
 * @returns {Promise<void>}
 */
export async function runMacroAutoRegister(deps = {}) {
  const pluginRoot = deps.pluginRoot || getPluginRoot();
  let sweep = deps.sweepAutoRegister;
  if (!sweep) {
    const macroPath = path.join(pluginRoot, 'lib', 'learning', 'macro-learner.js');
    const mod = await import(toFileUrl(macroPath));
    sweep = mod.sweepAutoRegister;
  }
  const config = deps.config || (await readArtibotConfig());
  const result = await sweep({ pluginRoot, config });
  const count = Array.isArray(result?.registered) ? result.registered.length : 0;
  if (count > 0) {
    process.stderr.write(`[artibot:macros-auto-registered count=${count}]\n`);
  }
  return { registered: count };
}

// Direct-run guard: importing this module (tests) must not execute a real
// SessionEnd — the pipeline writes to the live learning store and blocks on
// stdin, so an import was both a data hazard and a hang.
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(createErrorHandler('session-end', { exit: true }));
}
