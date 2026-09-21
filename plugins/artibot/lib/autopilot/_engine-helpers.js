/**
 * Engine-internal helpers shared between engine.js and goal-loop.js
 * (v4.6.0). Extracted as a module-private utility to keep engine.js
 * under the 800-line quality-gate threshold while still letting the
 * goal-driven iteration loop reuse the same telemetry / persistence /
 * phase-record primitives.
 *
 * Underscored filename signals "internal — not part of the public
 * autopilot surface". Do not re-export from index.js.
 *
 * @module lib/autopilot/_engine-helpers
 */

import { newSessionId, saveSession } from './session-store.js';
import { observePreIntake } from './auto-wire.js';
import { findUnterminatedPhases } from './replay.js';
import { reconcileAttemptOnResume } from './phase-attempt.js';
import { appendEvent, readEvents } from './telemetry.js';
import { notifyDanger, notifyPause, notifyPhaseProgress } from './notification.js';
import { acquireKeepAwake } from '../system/keep-awake.js';

/**
 * Live keep-awake handles by sessionId. Engine acquires in startAutopilot
 * and releases in runPhase6Report / abortAutopilot. Kept out of engine.js
 * to stay under the 800-line quality gate.
 * @type {Map<string, {active: boolean, since: string, platform: string, reason: string|null, release: () => Promise<void>}>}
 */
const KEEP_AWAKE_HANDLES = new Map();

/**
 * Acquire a keep-awake lease for the given session and remember it.
 * No-op when state.options.keepAwake === false. Errors are swallowed.
 * @param {object} state - live session state
 * @returns {Promise<object|null>} the handle (also stored in state.keepAwake) or null
 */
export async function acquireSessionKeepAwake(state) {
  if (!state || !state.sessionId) return null;
  if (state.options?.keepAwake === false) return null;
  try {
    const handle = await acquireKeepAwake({
      reason: `artibot-autopilot ${state.sessionId}`,
      keepDisplay: state.options?.keepDisplay === true,
    });
    KEEP_AWAKE_HANDLES.set(state.sessionId, handle);
    state.keepAwake = {
      active: handle.active,
      since: handle.since,
      platform: handle.platform,
      reason: handle.reason,
    };
    return handle;
  } catch {
    return null;
  }
}

/**
 * Release the keep-awake lease tied to a session, if any. Idempotent.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function releaseSessionKeepAwake(sessionId) {
  if (!sessionId) return;
  const handle = KEEP_AWAKE_HANDLES.get(sessionId);
  if (!handle) return;
  KEEP_AWAKE_HANDLES.delete(sessionId);
  try { await handle.release(); } catch { /* best-effort */ }
}
import { shouldActivateTui } from './tui.js';
import { recordPhaseUsage } from './cost-tracker.js';
import { budgetStatus, normalizeBudget } from './safety.js';

/**
 * Coerce a budget option into a positive finite number, accepting numeric
 * strings; anything else (absent, empty, NaN, <= 0) yields undefined.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function budgetOption(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Format a token count compactly (1.2M / 12.3k / 450) for budget messages.
 * @param {number} n
 * @returns {string}
 */
function fmtTokens(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

/**
 * Build the initial autopilot session state object. Factored out of
 * engine.js to keep that module under the 800-line quality gate and
 * to colocate state-shape concerns next to the persistence helpers.
 *
 * BUDGET UNITS (F03): `budgetTokens` is the canonical field and the default
 * 2_000_000 matches the documented `--budget <tokens>`. The legacy `budget`
 * key is still mirrored so readers that have not migrated yet
 * (`prd-generator.js:125`) keep working. Removal plan: one release after
 * `budgetTokens` ships, drop the mirror here and the compat read in
 * `safety.js#normalizeBudget` together — they are the only two sites.
 *
 * AUTO-WIRE OBSERVATION (Wave 11): this is where the one and only wired
 * auto-wire helper fires — data-only. `autoWireDeps` is a top-level arg, NOT
 * an `options` key, because `options` is persisted into the session JSON and
 * function handles do not belong in a file on disk.
 *
 * @param {{ task: string, mode?: string, options?: object, sessionId?: string,
 *   autoWireDeps?: {listSessions?: Function, readEvents?: Function, cwd?: string} }} args
 * @returns {object} initial state
 */
export function makeInitialState({ task, mode, options, sessionId, autoWireDeps }) {
  const id = sessionId || newSessionId();
  const requestedOptions = options && typeof options === 'object' ? options : {};
  // A caller that only knows the legacy flag still gets a canonical token
  // limit; an explicit budgetTokens always wins. Coercion happens HERE, at the
  // state boundary: the command driver hands `--budget 500000` over as text,
  // and `normalizeBudget` deliberately rejects strings, so an uncoerced value
  // would persist as a string and silently mean "no limit". A value that is
  // not a positive number falls back to the documented default (fail-closed).
  const budgetTokens = budgetOption(requestedOptions.budgetTokens)
    ?? budgetOption(requestedOptions.budget) ?? 2_000_000;
  const budgetUsd = budgetOption(requestedOptions.budgetUsd);
  const state = {
    sessionId: id,
    task: task || '',
    mode: mode || 'default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options: {
      maxDuration: '4h',
      ...requestedOptions,
      budgetTokens,
      budgetUsd,
      // Legacy mirror of the SAME resolved value — see the BUDGET UNITS note
      // above; two different numbers here would give the two readers two answers.
      budget: budgetTokens,
      // Command parsing owns aliases; engine state accepts exactly one
      // canonical representation so persisted/resumed sessions are unambiguous.
      fast: requestedOptions.fast === true,
    },
    phase: 'INTAKE',
    prdPath: null,
    reportPath: null,
    phases: [],
    checkpoints: [],
    queuedQuestions: [],
    errors: [],
    counters: { buildFailures: 0, testFailures: 0 },
    tokenUsage: 0,
    lastReviewedSHA: null,
    worktreePath: null,
    lockPath: null,
    parentSession: options?.parentSession || null,
    // v4.6.0 Goal-driven mode slots (null/zero for legacy sessions).
    goalContract: null,
    goalIterations: 0,
    lastIterationSHA: null,
    consecutiveSameSHA: 0,
    goalEvaluation: null,
    // v4.6.0 Phase 3 — Goal-level control plane (orthogonal to session pause).
    goalPaused: false,
    goalControl: null,
  };
  // Wave 11 data-only observation (PRD v5-ga-roadmap-audit-fold-20260914
  // "7행 최소 연결" 3행): recorded once per session here — startAutopilot is the
  // only makeInitialState caller and resume never re-enters it — and never
  // consumed by any phase runner. observePreIntake absorbs its own errors, so
  // this line cannot break session startup.
  state.autoWire = { preIntake: observePreIntake(state, autoWireDeps || {}) };
  tick(id, {
    phase: 'INTAKE',
    type: 'auto-wire-pre-intake',
    level: 'info',
    message: 'pre-intake auto-wire observed (data-only, applied=false)',
    data: state.autoWire.preIntake,
  });
  return state;
}

/**
 * Best-effort telemetry tick. Never throws into phase logic — telemetry
 * is advisory and must not break the engine flow.
 * @param {string} sessionId
 * @param {object} event
 */
export function tick(sessionId, event) {
  try {
    if (!sessionId) return;
    appendEvent(sessionId, event);
  } catch {
    /* telemetry must not break engine flow */
  }
}

/**
 * Append a phase record. Mutates state.
 * @param {object} state
 * @param {object} phase
 */
export function recordPhase(state, phase) {
  state.phases = Array.isArray(state.phases) ? state.phases : [];
  state.phases.push({ ts: new Date().toISOString(), ...phase });
}

/**
 * Persist a state mutation safely. Returns the saved state.
 * @param {object} state
 * @returns {object}
 */
export function persist(state) {
  state.updatedAt = new Date().toISOString();
  saveSession(state);
  return state;
}

/**
 * Copy a notifier's `queued` payload into the LIVE state's queue, in the same
 * shape `notification.js#queueOnSession` writes to disk.
 *
 * Why this exists: `queueOnSession` is a read-modify-write against the session
 * **file**, and a notifier that fires mid-mutation therefore queues onto a state
 * the caller is about to overwrite with its own whole-state `persist`. Two
 * distinct losses follow — the entry is erased when the file already existed,
 * and it is never written at all when it did not, because `queueOnSession`
 * no-ops on a session it cannot load. Merging into the in-memory state before
 * the persist closes both, and unlike "announce after the persist" it also
 * survives the NEXT persist of the same state, since the entry now lives in the
 * object every later write is made from.
 *
 * Never throws: every caller is a phase ACK point, and bookkeeping for an
 * announcement must not undo a transition the engine has already committed. A
 * hostile or absent notification degrades to "nothing merged".
 *
 * @param {object} state - Live session state (mutated).
 * @param {?object} notification - A `notification.js` result
 *   (`{tool, params?, suppressed, queued}`); `null` when the notifier failed.
 * @returns {boolean} true when an entry was appended.
 */
export function mergeQueuedNotification(state, notification) {
  try {
    const queued = notification?.queued;
    if (!queued || typeof queued !== 'object' || Array.isArray(queued)) return false;
    if (!Array.isArray(state.queuedQuestions)) state.queuedQuestions = [];
    state.queuedQuestions.push({ ts: new Date().toISOString(), ...queued });
    return true;
  } catch {
    return false; /* queue bookkeeping is best-effort; the transition stands */
  }
}

/**
 * Build a danger notification when pause reason or error severity signals
 * a safety-critical event. Returns null when no danger is detected.
 * @param {object} state
 * @param {string} reason
 * @returns {object|null}
 */
export function maybeDangerNote(state, reason) {
  const errs = Array.isArray(state.errors) ? state.errors : [];
  const dangerErr = errs.find((e) => e?.severity === 'danger');
  if (!dangerErr && !/secret-leak|danger/i.test(reason)) return null;
  return notifyDanger(state.sessionId, {
    riskType: dangerErr?.kind || reason,
    detail: dangerErr?.detail ?? reason,
  });
}

/**
 * Best-effort phase-progress notification. Throttled inside notifyPhaseProgress.
 * @param {object} state
 * @param {string} fromPhase
 * @param {string} toPhase
 * @param {number|null} [durationMs]
 * @returns {object|null}
 */
export function notePhaseProgress(state, fromPhase, toPhase, durationMs = null) {
  try {
    return notifyPhaseProgress(state.sessionId, { fromPhase, toPhase, durationMs });
  } catch {
    return null;
  }
}

/**
 * Best-effort cost recorder. Wraps cost-tracker.recordPhaseUsage so engine
 * code can drop a single line per phase boundary without try/catch noise.
 * Silent no-op on invalid input or persistence failure — cost tracking is
 * advisory and must never block the engine.
 *
 * @param {object} state - live session state (must expose sessionId)
 * @param {string} phase - canonical phase label (e.g. 'EXECUTE')
 * @param {{tokensIn?:number, tokensOut?:number, costUsd?:number, model?:string}} usage
 * @returns {object|null} delta applied or null on failure
 */
export function notePhaseCost(state, phase, usage) {
  try {
    if (!state || typeof state !== 'object' || !state.sessionId) return null;
    return recordPhaseUsage(state.sessionId, phase, usage);
  } catch {
    return null;
  }
}

/**
 * Build a notification instruction when a budget threshold (50/80/95%) is
 * crossed. The 95% line is the hard danger gate — it routes through
 * notifyDanger (suppression-exempt, no throttle). 50/80 use notifyPause so
 * the user sees a real PushNotification but other surfaces (night mode) can
 * still mute it.
 *
 * Returns null when no threshold is crossed or when state is unusable.
 *
 * The message is rendered in the unit that actually crossed — a token
 * threshold printed with a `$` sign is what let F03 hide in plain sight.
 *
 * @param {object} state - live session state (budget limits via normalizeBudget)
 * @param {{ crossed: 50|80|95|null, unit?: 'tokens'|'usd', used: number,
 *           percent: number }} threshold
 * @param {{notifyPause?:Function, notifyDanger?:Function}} [deps] - test seam
 * @returns {object|null} notification instruction or null
 */
export function buildCostWarningInstruction(state, threshold, deps = {}) {
  if (!state || typeof state !== 'object' || !state.sessionId) return null;
  if (!threshold || threshold.crossed === null || threshold.crossed === undefined) return null;
  const pct = Number.isFinite(threshold.percent) ? threshold.percent : 0;
  const used = Number.isFinite(threshold.used) ? threshold.used : 0;
  const limits = normalizeBudget(state.options);
  const unit = threshold.unit === 'usd' ? 'usd' : 'tokens';
  const limit = (unit === 'usd' ? limits.budgetUsd : limits.budgetTokens) ?? 0;
  const amounts = unit === 'usd'
    ? `$${used.toFixed(4)} / $${limit.toFixed(4)}`
    : `${fmtTokens(used)} / ${fmtTokens(limit)} tokens`;
  const reason = `budget ${threshold.crossed}% reached (${amounts} = ${pct}%)`;
  const danger = typeof deps.notifyDanger === 'function' ? deps.notifyDanger : notifyDanger;
  const pause = typeof deps.notifyPause === 'function' ? deps.notifyPause : notifyPause;
  try {
    if (threshold.crossed === 95) {
      return danger(state.sessionId, {
        riskType: 'budget-threshold-95',
        detail: {
          used, limit, percent: pct, unit,
        },
      });
    }
    return pause(state.sessionId, reason);
  } catch {
    return null;
  }
}

/**
 * Budget gate for the engine's dispatch / resume-ACK sites.
 *
 * Emits telemetry and returns the status; it never pauses by itself —
 * `safety.js#shouldPause` owns that decision, and this gate exists so the
 * decision is *observable* before and after every delegation.
 *
 * Three events: `budget-check` (info) on every call, `budget-usage-unknown`
 * (warn) once per session, and `budget-exceeded` (warn) whenever a unit is
 * exhausted. The unknown warning is deduped via `state.usage.unknownWarnedAt`
 * so a long run does not emit it on every dispatch.
 *
 * Never throws — a budget gate that crashes the engine is worse than one
 * that misses a warning.
 *
 * @param {object} state - live session state
 * @param {'dispatch'|'ack'} site - where the gate fired
 * @param {{appendEvent?:Function, persist?:Function}} [deps] - test seam
 * @returns {object|null} budgetStatus, or null when state is unusable
 */
export function checkBudgetGate(state, site, deps = {}) {
  try {
    if (!state || typeof state !== 'object' || !state.sessionId) return null;
    const emit = typeof deps.appendEvent === 'function'
      ? (id, ev) => { try { deps.appendEvent(id, ev); } catch { /* best-effort */ } }
      : tick;
    const save = typeof deps.persist === 'function' ? deps.persist : persist;
    const status = budgetStatus(state);
    const data = { site, ...status };
    emit(state.sessionId, {
      phase: state.phase || null, type: 'budget-check', level: 'info', message: `budget check @${site}`, data,
    });
    if (!status.usageKnown) {
      const usage = state.usage && typeof state.usage === 'object' ? state.usage : {};
      if (typeof usage.unknownWarnedAt !== 'string') {
        usage.unknownWarnedAt = new Date().toISOString();
        state.usage = usage;
        emit(state.sessionId, {
          phase: state.phase || null,
          type: 'budget-usage-unknown',
          level: 'warn',
          message: 'budget limit configured but usage was never measured — treating as unknown, not as under budget',
          data,
        });
        try { save(state); } catch { /* persistence best-effort */ }
      }
    }
    if (status.tokens?.exceeded === true || status.usd?.exceeded === true) {
      emit(state.sessionId, {
        phase: state.phase || null, type: 'budget-exceeded', level: 'warn', message: `budget exhausted @${site}`, data,
      });
    }
    return status;
  } catch {
    return null;
  }
}

/**
 * Build the TUI instruction marker attached to startAutopilot's return value.
 * Returns null when TUI should be inactive (night mode, --no-tui, TTY-less env).
 * The marker is intentionally not a real tool call — the main Claude reads it
 * and decides whether to spawn `runTuiLoop` in the background.
 *
 * @param {object} state
 * @param {{ isTTY?: boolean }} [env]
 * @returns {object|null}
 */
export function buildTuiInstruction(state, env = {}) {
  if (!state || !state.sessionId) return null;
  if (!shouldActivateTui(state, env)) return null;
  return {
    tool: 'autopilot:tui-render',
    sessionId: state.sessionId,
    intervalMs: 1000,
    hint: 'Main Claude should render the TUI via runTuiLoop() while polling phase results.',
  };
}

/**
 * Build a PushNotification instruction from a preflight result.
 *
 * Three-way switch:
 *   - ok=true, no warnings → null (silent pass-through)
 *   - errors.length > 0    → blocking PushNotification with abort=true
 *   - warnings only        → suppressed notice, abort=false
 *
 * Returns shape compatible with the orchestrator's instruction array.
 *
 * @param {{ ok: boolean, errors: object[], warnings: object[], checks: object[] }} preflightResult
 * @returns {object|null}
 */
export function buildPreflightInstruction(preflightResult) {
  if (!preflightResult || typeof preflightResult !== 'object') return null;
  const errors = Array.isArray(preflightResult.errors) ? preflightResult.errors : [];
  const warnings = Array.isArray(preflightResult.warnings) ? preflightResult.warnings : [];
  if (preflightResult.ok && errors.length === 0 && warnings.length === 0) return null;

  if (errors.length > 0) {
    const checks = errors.map((e) => e.check).join(', ');
    return {
      tool: 'PushNotification',
      params: {
        title: 'Autopilot pre-flight failed',
        message: `Blocking issues: ${checks}`,
      },
      suppress: false,
      abort: true,
      summary: `preflight blocked by ${errors.length} hard fail(s): ${checks}`,
    };
  }

  // warnings-only path
  const checks = warnings.map((w) => w.check).join(', ');
  return {
    tool: null,
    suppress: true,
    abort: false,
    summary: `preflight passed with ${warnings.length} warning(s): ${checks}`,
  };
}

/**
 * Render preflight checks as a GFM pipe-table (Check | Status | Detail).
 * Suitable for REPORT phase markdown sections.
 *
 * @param {{ checks: Array<{ name: string, status: string, detail?: string }> }} result
 * @returns {string}
 */
export function renderPreflightSummary(result) {
  const rows = Array.isArray(result?.checks) ? result.checks : [];
  const header = '| Check | Status | Detail |\n| --- | --- | --- |';
  if (rows.length === 0) return `${header}\n| _(no checks)_ |  |  |`;
  const body = rows
    .map((r) => `| ${r.name} | ${r.status} | ${r.detail ? r.detail.replace(/\|/g, '\\|') : ''} |`)
    .join('\n');
  return `${header}\n${body}`;
}

/**
 * Crash-recovery detector: did the previous process die inside a phase?
 *
 * Reads the session's **NDJSON event log** — the only durable record that
 * production actually writes. `tick()` emits `phase-start` / `phase-end` there
 * on every phase transition, so a `phase-start` with no matching `phase-end`
 * means the process never reached the end of that phase.
 *
 * Previously this read `state.timeline`, a field with **zero production
 * writers** (`session-store.js#migrateState` guaranteed an empty array and
 * nothing ever appended to it). The detector therefore returned
 * `{interrupted:false}` unconditionally in every real session — a fail-open
 * that the unit tests could not see, because they hand-built `timeline`
 * fixtures that no code path produces.
 *
 * Pairing is delegated to `replay.js#findUnterminatedPhases` so the
 * start/end walk has exactly one home.
 *
 * All errors are absorbed — recovery detection MUST NOT throw into the engine
 * startup path. A detector that crashes resume is worse than one that misses.
 *
 * @param {object} state - Live session state; only `sessionId` is read.
 * @param {{events?: object[]}} [opts] - `events` is a unit-test seam that
 *   bypasses the file read. Production always passes nothing; the real NDJSON
 *   path is covered by the crash smoke test, not by this seam.
 * @returns {{ interrupted: true, phase: string, startedAt: string|null } | { interrupted: false }}
 */
export function detectInterruptedPhase(state, opts = {}) {
  try {
    if (!state || typeof state !== 'object') return { interrupted: false };
    const sessionId = typeof state.sessionId === 'string' && state.sessionId
      ? state.sessionId : null;
    const events = Array.isArray(opts?.events)
      ? opts.events
      : (sessionId ? readEvents(sessionId) : []);
    const pending = findUnterminatedPhases(events);
    if (pending.length === 0) return { interrupted: false };
    const last = pending[pending.length - 1];
    return { interrupted: true, phase: last.phase, startedAt: last.startedAt };
  } catch {
    return { interrupted: false };
  }
}

/**
 * Build a user-facing (한국어) recovery banner string when the prior session
 * crashed mid-phase. Returns null when no recovery action is needed.
 *
 * **This banner must predict what resume will actually do.** The driver shows
 * it *before* calling `resumeAutopilot` (`commands/autopilot.md` § Step 2 —
 * Mode Dispatch, `resume` row), so a banner that disagrees with the engine
 * hands the operator two opposite instructions inside one resume.
 *
 * That is exactly what ADR-005 2단 introduced and this function now closes.
 * 1단 had one answer — re-enter the interrupted phase — because that was the
 * only thing resume did. 2단 added a second: an un-acknowledged
 * `activePhaseAttempt` makes `engine.js#settleOutstandingAttempt` PAUSE (or,
 * for an allowlisted phase, re-run) instead of re-entering. So the attempt is
 * consulted **first**, and only a session with no outstanding attempt falls
 * through to the 1단 wording, which is still correct for that case.
 *
 * The attempt wording is not restated here — `reconcileAttemptOnResume`
 * returns the note it will act on, and reusing it verbatim is what keeps one
 * owner for the text. Duplicating the sentences is how the two drifted apart
 * in the first place.
 *
 * @param {object} state - Live session state; `sessionId` and
 *   `activePhaseAttempt` are read.
 * @param {{events?: object[]}} [opts] - Forwarded to
 *   {@link detectInterruptedPhase}; unit-test seam only.
 * @returns {string|null}
 */
export function buildRecoveryNote(state, opts = {}) {
  try {
    // Attempt first: it outranks phase pairing. A delegating phase writes no
    // `phase-end` until ACK, so an outstanding attempt and an unterminated
    // phase describe the SAME crash — and only the attempt knows whether
    // resume will pause or redo it.
    const reconciled = reconcileAttemptOnResume(state);
    if (reconciled.action !== 'none') return reconciled.note;

    const result = detectInterruptedPhase(state, opts);
    if (!result.interrupted) return null;
    const tsPart = result.startedAt ? ` (${result.startedAt})` : '';
    return `이전 세션이 ${result.phase} 단계 진행 중 중단됨${tsPart}. 자동으로 ${result.phase} 재진입합니다.`;
  } catch {
    return null;
  }
}
