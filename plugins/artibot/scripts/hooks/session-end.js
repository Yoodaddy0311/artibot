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
import { createErrorHandler, getStatePath, logHookError } from '../../lib/core/hook-utils.js';
import { isMainEntry } from './_main-entry.js';

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

// ---------------------------------------------------------------------------
// Usage receipts (economics)
// ---------------------------------------------------------------------------

/**
 * Result of a run in which nothing was written. Every branch starts here so a
 * caller never has to branch on `undefined`, and `coverage: null` keeps
 * "measured nothing" distinct from "measured zero spend".
 * @type {Readonly<object>}
 */
const EMPTY_RECEIPT_RESULT = Object.freeze({
  status: 'skipped',
  appended: 0,
  rejected: 0,
  deduped: 0,
  receipts: 0,
  reason: null,
  coverage: null,
});

/**
 * Pair a result patch with the unresolved-model list. The list rides ALONGSIDE
 * the result rather than inside it: the returned contract is a fixed set of
 * keys, and the model names belong on the stderr line only.
 *
 * @param {object} patch - Fields overriding {@link EMPTY_RECEIPT_RESULT}.
 * @param {string[]} [unresolved] - Transcript model strings the catalog rejected.
 * @returns {{result: object, unresolved: string[]}}
 */
function receiptOutcome(patch, unresolved = []) {
  return { result: { ...EMPTY_RECEIPT_RESULT, ...patch }, unresolved };
}

/**
 * Collapse a reason to one bounded, single-line token. A stack-trace-shaped
 * message would otherwise break the one-line stderr contract and bury the
 * fields that follow it.
 *
 * @param {unknown} message
 * @param {number} [max]
 * @returns {string}
 */
function truncateReason(message, max = 120) {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The three payload fields a receipt run cannot proceed without.
 *
 * `cwd` is REQUIRED rather than defaulted to `process.cwd()`: a globally
 * installed hook runs from wherever the host happened to be, so deriving the
 * root from the process would append this project's spend to a stranger's
 * ledger (same rule as `scripts/hooks/pre-bash.js`).
 *
 * @param {object} hookData
 * @returns {{reason: string|null, transcriptPath?: string, sessionId?: string, cwd?: string}}
 */
function receiptPrecondition(hookData) {
  const transcriptPath = hookData?.transcript_path;
  const sessionId = hookData?.session_id;
  const cwd = hookData?.cwd;
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return { reason: 'no-transcript' };
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) return { reason: 'no-session-id' };
  if (typeof cwd !== 'string' || cwd.length === 0) return { reason: 'no-cwd' };
  return { reason: null, transcriptPath, sessionId, cwd };
}

/**
 * Resolve the ports this stage needs, honouring injected overrides.
 *
 * Dynamic imports on purpose: a static import runs at module load, so it would
 * run inside every test that merely imports this hook. Each `??` short
 * circuits, so a fully injected call imports nothing at all.
 *
 * @param {object} deps - Injection seam; see {@link recordUsageReceipts}.
 * @returns {Promise<object>} every port this stage calls
 */
async function resolveReceiptDeps(deps) {
  const pluginRoot = deps.pluginRoot || getPluginRoot();
  const load = (...rel) => import(toFileUrl(path.join(pluginRoot, ...rel)));
  return {
    now: deps.now ?? (() => new Date()),
    buildUsageReceipts: deps.buildUsageReceipts
      ?? (await load('lib', 'economics', 'usage-receipt.js')).buildUsageReceipts,
    toUsageReceiptEnvelopes: deps.toUsageReceiptEnvelopes
      ?? (await load('lib', 'economics', 'receipt-envelope.js')).toUsageReceiptEnvelopes,
    appendLedgerEvent: deps.appendLedgerEvent
      ?? (await load('lib', 'runtime', 'ledger.js')).appendLedgerEvent,
    readAllEvents: deps.readAllEvents
      ?? (await load('lib', 'runtime', 'ledger.js')).readAllEvents,
    resolveProjectRoot: deps.resolveProjectRoot
      ?? (await load('lib', 'git', 'project-root.js')).resolveProjectRoot,
    sessionFallbackMissionId: deps.sessionFallbackMissionId
      ?? (await load('lib', 'mission', 'mission-id.js')).sessionFallbackMissionId,
    isMissionId: deps.isMissionId
      ?? (await load('lib', 'mission', 'mission-id.js')).isMissionId,
  };
}

/**
 * Mission this session's spend belongs to: the declared id when it is one, the
 * session-derived fallback otherwise. Same order as
 * `scripts/hooks/subagent-handler.js#resolveMissionId` — two hooks disagreeing
 * about which mission a session belongs to would split one mission's ledger.
 *
 * @param {object} hookData
 * @param {string} sessionId
 * @param {object} d - Resolved ports.
 * @returns {string|null} null when no valid id can be formed.
 */
function resolveReceiptMissionId(hookData, sessionId, d) {
  const declared = hookData?.mission_id ?? hookData?.missionId;
  try {
    if (d.isMissionId(declared)) return declared;
    const id = d.sessionFallbackMissionId({ sessionId, nowMs: d.now().getTime() });
    return d.isMissionId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the ledger root from the payload cwd, or null.
 * @param {object} d - Resolved ports.
 * @param {string} cwd
 * @returns {string|null}
 */
function safeProjectRoot(d, cwd) {
  try {
    const root = d.resolveProjectRoot(cwd);
    return typeof root === 'string' && root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/**
 * Idempotency keys of the `usage.receipt` lines this session already wrote.
 * READER, not writer.
 *
 * `lib/runtime/ledger.js#applyUsageReceipt` SUMS every receipt it folds, so a
 * SessionEnd firing twice over one session (an ended `--resume` is the observed
 * way) would double that session's recorded spend.
 *
 * An unreadable ledger yields an EMPTY set, which PERMITS the append: a lost
 * receipt is a permanent hole in the measurement, whereas a duplicate is
 * visible in the ledger and removable.
 *
 * @param {object} d - Resolved ports.
 * @param {string} projectRoot
 * @param {string} sessionId
 * @returns {Set<string>}
 */
function existingReceiptKeys(d, projectRoot, sessionId) {
  try {
    const events = d.readAllEvents(projectRoot, { session_id: sessionId });
    const keys = new Set();
    for (const event of Array.isArray(events) ? events : []) {
      if (event?.event !== 'usage.receipt') continue;
      const key = event.idempotency_key;
      if (typeof key === 'string' && key.length > 0) keys.add(key);
    }
    return keys;
  } catch {
    return new Set();
  }
}

/**
 * Append every envelope the ledger does not already carry, and grade the run.
 *
 * @param {object} d - Resolved ports.
 * @param {string} projectRoot
 * @param {object[]} envelopes
 * @param {Set<string>} seen - Keys already in the ledger.
 * @returns {{status: string, appended: number, rejected: number, deduped: number,
 *   reason: string|null}}
 */
function appendReceiptEnvelopes(d, projectRoot, envelopes, seen) {
  let appended = 0;
  let rejected = 0;
  let deduped = 0;
  let reason = null;

  for (const envelope of envelopes) {
    if (seen.has(envelope.idempotency_key)) {
      deduped += 1;
      continue;
    }
    const result = d.appendLedgerEvent(projectRoot, envelope);
    if (result?.ok) {
      appended += 1;
      continue;
    }
    rejected += 1;
    if (reason === null) reason = truncateReason(result?.reason ?? 'append-failed');
  }

  const status = appended > 0 ? 'appended' : (rejected > 0 ? 'failed' : 'skipped');
  if (appended === 0 && rejected === 0) {
    reason = deduped > 0 ? 'already-recorded' : 'no-envelopes';
  }
  return { status, appended, rejected, deduped, reason };
}

/**
 * The whole receipt stage minus the reporting. May throw; its caller may not.
 *
 * @param {object} hookData
 * @param {object} deps
 * @returns {Promise<{result: object, unresolved: string[]}>}
 */
async function collectUsageReceipts(hookData, deps) {
  const pre = receiptPrecondition(hookData);
  if (pre.reason !== null) return receiptOutcome({ reason: pre.reason });
  const { transcriptPath, sessionId, cwd } = pre;

  const d = await resolveReceiptDeps(deps);
  const missionId = resolveReceiptMissionId(hookData, sessionId, d);
  if (missionId === null) return receiptOutcome({ reason: 'no-mission-id' });

  const projectRoot = safeProjectRoot(d, cwd);
  if (projectRoot === null) return receiptOutcome({ reason: 'no-project-root' });

  let built;
  try {
    built = await d.buildUsageReceipts({ transcriptPath, missionId });
  } catch (err) {
    return receiptOutcome({
      status: 'failed',
      reason: `parse-failed:${truncateReason(err?.message ?? err)}`,
    });
  }

  const receipts = Array.isArray(built?.receipts) ? built.receipts : [];
  const coverage = typeof built?.meta?.coverage === 'number' ? built.meta.coverage : null;
  const unresolved = Object.keys(built?.meta?.unresolvedModels ?? {});
  if (receipts.length === 0) return receiptOutcome({ reason: 'no-receipts', coverage }, unresolved);

  const envelopes = d.toUsageReceiptEnvelopes(receipts, { sessionId });
  const tally = appendReceiptEnvelopes(
    d, projectRoot, envelopes, existingReceiptKeys(d, projectRoot, sessionId),
  );
  return receiptOutcome({ ...tally, receipts: receipts.length, coverage }, unresolved);
}

/**
 * The one stderr line this stage emits.
 * @param {object} result
 * @param {string[]} [unresolved]
 * @returns {string}
 */
function formatUsageReceiptLine(result, unresolved = []) {
  const parts = [
    `[economics] usage.receipt: status=${result.status}`,
    `appended=${result.appended}`,
    `rejected=${result.rejected}`,
    `deduped=${result.deduped}`,
    `receipts=${result.receipts}`,
    `coverage=${result.coverage === null ? 'null' : result.coverage}`,
    `reason=${result.reason ?? '-'}`,
  ];
  if (unresolved.length > 0) parts.push(`unresolved=${unresolved.join('·')}`);
  return `${parts.join(' ')}\n`;
}

/**
 * Read this session's Attempt Receipts out of the transcript and append them to
 * the project ledger as `usage.receipt` events.
 *
 * This is the ONLY writer of that event (the single-writer rule restated in
 * `lib/economics/usage-receipt.js`): `cache-roi.js` and `token-usage.js` must
 * never also fold the same tokens into a receipt.
 *
 * Observe-phase contract: no behaviour change, no file artifacts, ledger rows
 * only. Never throws and never alters the hook's outcome — a failure to MEASURE
 * spend must not become a failure to END a session.
 *
 * @param {object} hookData - SessionEnd payload.
 * @param {object} [deps] - Injection seam. Any of `buildUsageReceipts`,
 *   `toUsageReceiptEnvelopes`, `appendLedgerEvent`, `readAllEvents`,
 *   `resolveProjectRoot`, `sessionFallbackMissionId`, `isMissionId`,
 *   `pluginRoot`, `now`. Anything absent is imported dynamically.
 * @returns {Promise<{status: string, appended: number, rejected: number,
 *   deduped: number, receipts: number, reason: string|null, coverage: number|null}>}
 */
export async function recordUsageReceipts(hookData, deps = {}) {
  let outcome;
  try {
    outcome = await collectUsageReceipts(hookData, deps);
  } catch (err) {
    // No logHookError here on purpose: the brief fixes this stage at ONE
    // stderr line, and the summary below already carries `reason=`. A second
    // line would say the same thing twice (review 2026-09-05, probe: 2 lines).
    outcome = receiptOutcome({ status: 'failed', reason: truncateReason(err?.message ?? err) });
  }
  process.stderr.write(formatUsageReceiptLine(outcome.result, outcome.unresolved));
  return outcome.result;
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  saveSessionState(hookData);

  if (!hookData) return;

  // Before the learning pipeline: that stage owns most of the 10s hook budget,
  // and a ledger row missing because measurement ran last is indistinguishable
  // from spend that never happened.
  await recordUsageReceipts(hookData);

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
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('session-end', { exit: true }));
}
