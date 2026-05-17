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
import { appendEvent } from './telemetry.js';
import { notifyDanger, notifyPause, notifyPhaseProgress } from './notification.js';
import { shouldActivateTui } from './tui.js';
import { recordPhaseUsage } from './cost-tracker.js';

/**
 * Build the initial autopilot session state object. Factored out of
 * engine.js to keep that module under the 800-line quality gate and
 * to colocate state-shape concerns next to the persistence helpers.
 *
 * @param {{ task: string, mode?: string, options?: object, sessionId?: string }} args
 * @returns {object} initial state
 */
export function makeInitialState({ task, mode, options, sessionId }) {
  const id = sessionId || newSessionId();
  return {
    sessionId: id,
    task: task || '',
    mode: mode || 'default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options: { maxDuration: '4h', budget: 2_000_000, ...(options || {}) },
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
 * @param {object} state - live session state (reads state.options.budget)
 * @param {{ crossed: 50|80|95|null, used: number, percent: number }} threshold
 * @returns {object|null} notification instruction or null
 */
export function buildCostWarningInstruction(state, threshold) {
  if (!state || typeof state !== 'object' || !state.sessionId) return null;
  if (!threshold || threshold.crossed === null || threshold.crossed === undefined) return null;
  const pct = Number.isFinite(threshold.percent) ? threshold.percent : 0;
  const used = Number.isFinite(threshold.used) ? threshold.used : 0;
  const limit = Number(state.options?.budget) || 0;
  const reason = `budget ${threshold.crossed}% reached ($${used.toFixed(4)} / $${limit.toFixed(4)} = ${pct}%)`;
  try {
    if (threshold.crossed === 95) {
      return notifyDanger(state.sessionId, {
        riskType: 'budget-threshold-95',
        detail: { used, limit, percent: pct },
      });
    }
    return notifyPause(state.sessionId, reason);
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
 * Crash-recovery detector. Walks the timeline in order and pairs each
 * `phase-start` with the next matching `phase-end` (same `phase`). A
 * `phase-start` left without a successor implies the prior process died
 * mid-phase.
 *
 * Timeline contract (post-v2 migration):
 *   [{ type: 'phase-start', phase: string, ts: string }, ...]
 *
 * All errors are absorbed — recovery detection MUST NOT throw into the
 * engine startup path.
 *
 * @param {object} state
 * @returns {{ interrupted: true, phase: string, startedAt: string|null } | { interrupted: false }}
 */
export function detectInterruptedPhase(state) {
  try {
    if (!state || typeof state !== 'object') return { interrupted: false };
    const timeline = Array.isArray(state.timeline) ? state.timeline : [];
    // Stack-based pairing: phase-start pushes, matching phase-end pops the
    // most recent open entry. Assumes phases nest LIFO (engine.js never
    // overlaps unrelated phases). Orphaned phase-end entries are ignored
    // as data drift.
    const pending = [];
    for (const entry of timeline) {
      if (!entry || typeof entry !== 'object') continue;
      const type = entry.type;
      const phase = typeof entry.phase === 'string' ? entry.phase : null;
      if (!phase) continue;
      if (type === 'phase-start') {
        pending.push({ phase, startedAt: typeof entry.ts === 'string' ? entry.ts : null });
      } else if (type === 'phase-end') {
        for (let i = pending.length - 1; i >= 0; i -= 1) {
          if (pending[i].phase === phase) {
            pending.splice(i, 1);
            break;
          }
        }
      }
    }
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
 * @param {object} state
 * @returns {string|null}
 */
export function buildRecoveryNote(state) {
  try {
    const result = detectInterruptedPhase(state);
    if (!result.interrupted) return null;
    const tsPart = result.startedAt ? ` (${result.startedAt})` : '';
    return `이전 세션이 ${result.phase} 단계 진행 중 중단됨${tsPart}. 자동으로 ${result.phase} 재진입합니다.`;
  } catch {
    return null;
  }
}
