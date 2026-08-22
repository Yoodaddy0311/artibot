/**
 * Autopilot engine — state record/mutation helpers.
 *
 * Pure extraction from engine.js (no behavior change). These functions mutate
 * and persist session state but are independent of phase-flow orchestration.
 * One-directional: this module never imports engine.js.
 *
 * @module lib/autopilot/engine-state
 */

import { persist, recordPhase, tick } from './_engine-helpers.js';
import { appendLesson } from './memory.js';
import { ackPhaseAttempt } from './phase-attempt.js';

/**
 * Best-effort lesson append. Skips when state.featureKey is unset (Phase 0
 * has not run yet) and never throws into Phase logic.
 * @param {object} state
 * @param {object} payload - lesson body sans sessionId (auto-attached)
 */
export function safeAppendLesson(state, payload) {
  try {
    if (!state || !state.featureKey) return;
    appendLesson(state.featureKey, { sessionId: state.sessionId, ...payload });
  } catch {
    /* learn non-blocking */
  }
}

/**
 * Append a labeled phase result to state.phases. Surfaced for commands/autopilot.md.
 *
 * **This is also the ACK point for durable phase attempts** (see
 * `phase-attempt.js`). It was extended rather than joined by a separate
 * `ackPhaseAttempt()` export, deliberately:
 *
 *   - The driver already calls exactly this function at phase completion
 *     (commands/autopilot.md § "Step 3 — Phase Execution Loop"; cited by
 *     heading because step numbers and line numbers both drift). A second
 *     required call would mean a
 *     driver that forgets it leaves the attempt open forever, and every later
 *     resume would pause a perfectly healthy session — a fail-stuck worse than
 *     the bug being fixed.
 *   - "This phase finished" is one decision. Splitting it across two entry
 *     points splits a source of truth, which is the robustness veto.
 *
 * The signature and return value are unchanged, and the ACK is a no-op when no
 * matching attempt is open, so existing callers are unaffected. The paired
 * `phase-end` telemetry is emitted here — for armed phases the engine no
 * longer writes it at delegation time, because that is precisely what made a
 * mid-EXECUTE crash look like a cleanly closed phase.
 *
 * @param {object} state
 * @param {{ phase: string, status: string, [k: string]: any }} payload
 * @returns {object} mutated state
 */
export function recordPhaseResult(state, payload = {}) {
  if (!state) throw new TypeError('state required');
  const { phase, status, ...rest } = payload;
  recordPhase(state, { name: phase, status, ...rest });
  const acked = ackPhaseAttempt(state, { phase, status });
  if (acked) {
    tick(state.sessionId, {
      phase,
      type: 'phase-end',
      level: 'info',
      message: `Phase ${phase} 완료 확인 (attempt ${acked.attemptId})`,
      data: { attemptId: acked.attemptId, resultStatus: acked.resultStatus },
    });
  }
  if (phase === 'IMPROVE') {
    const improvements = Array.isArray(rest.improvements) ? rest.improvements : [];
    for (const item of improvements) {
      safeAppendLesson(state, {
        lesson: `Improvement: ${String(item).slice(0, 200)}`,
        successPattern: 'improve-suggestion',
        sourcePhase: 'IMPROVE',
      });
    }
    const futurePlans = Array.isArray(rest.futurePlans) ? rest.futurePlans : [];
    for (const plan of futurePlans) {
      safeAppendLesson(state, {
        lesson: `FuturePlan: ${String(plan).slice(0, 200)}`,
        successPattern: 'future-plan',
        sourcePhase: 'IMPROVE',
      });
    }
  }
  persist(state);
  return state;
}

/**
 * Append a checkpoint (typically a git SHA) to state.checkpoints.
 * @param {object} state
 * @param {{ sha?: string, label?: string, [k: string]: any }} payload
 * @returns {object} mutated state
 */
export function recordCheckpoint(state, payload = {}) {
  if (!state) throw new TypeError('state required');
  const { sha = null, label = null, ...rest } = payload;
  state.checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
  state.checkpoints.push({
    ts: new Date().toISOString(),
    sha,
    phase: state.phase,
    label,
    ...rest,
  });
  persist(state);
  return state;
}

/**
 * Classify a verify failure for downstream agent routing (Phase 4 onFailure path).
 * @param {{ command?: string, exitCode?: number|null, stderr?: string, stdout?: string }} payload
 * @returns {'typecheck'|'test'|'lint'|'build'|'unknown-failure'|'unknown'}
 */
export function classifyFailure(payload = {}) {
  const out = String(payload.stderr || payload.stdout || '').toLowerCase();
  if (/(?:typescript|\btsc\b|type error|ts\d{4})/i.test(out)) return 'typecheck';
  if (/(?:vitest|jest|\bspec\b|\btest\b)/i.test(out)) return 'test';
  if (/(?:eslint|lint error)/i.test(out)) return 'lint';
  if (/(?:webpack|rollup|esbuild|tsup|next build|\bbuild\b)/i.test(out)) return 'build';
  if (typeof payload.exitCode === 'number' && payload.exitCode !== 0) return 'unknown-failure';
  return 'unknown';
}

/**
 * Record a secret-leak event and freeze the session (PAUSED).
 * @param {object} state
 * @param {{ kind?: string, detail?: any, location?: string }} leak
 * @returns {object} mutated state
 */
export function recordSecretLeak(state, leak = {}) {
  if (!state) throw new TypeError('state required');
  const { kind = 'secret', detail = null, location = null } = leak;
  state.errors = Array.isArray(state.errors) ? state.errors : [];
  state.errors.push({
    ts: new Date().toISOString(),
    kind,
    detail,
    location,
  });
  if (state.phase && state.phase !== 'PAUSED') {
    state.lastPhase = state.phase;
  }
  state.phase = 'PAUSED';
  state.pausedReason = `secret-leak: ${kind}`;
  safeAppendLesson(state, {
    lesson: `SecretLeak at ${state.lastPhase || 'unknown'}: ${kind}`,
    errorPattern: `secret-leak:${kind}`,
    sourcePhase: state.lastPhase || null,
  });
  persist(state);
  return state;
}

/**
 * Record a runtime risk event surfaced by the Bash PreToolUse risk guard
 * (scripts/hooks/bash-risk-guard.js → lib/autopilot/safety.js#classifyRisk).
 *
 * Pushes an error carrying a `severity` field so shouldPause()'s
 * `severity === 'danger'` trigger becomes reachable — this is the runtime
 * feeder for the previously-dead branch in safety.js (audit ap-20260702 I-04).
 * Unlike {@link recordSecretLeak} this is a pure record: it does NOT mutate
 * `state.phase`. The pause decision stays owned by shouldPause()/maybePause()
 * so a single tick applies it consistently with the other pause triggers.
 *
 * @param {object} state
 * @param {{ level?: string, reason?: string, matchedId?: string, command?: string }} risk
 * @returns {object} mutated state
 */
export function recordRiskEvent(state, risk = {}) {
  if (!state) throw new TypeError('state required');
  const { level = 'danger', reason = null, matchedId = null, command = null } = risk;
  state.errors = Array.isArray(state.errors) ? state.errors : [];
  state.errors.push({
    ts: new Date().toISOString(),
    kind: 'risk',
    severity: level,
    reason,
    matchedId,
    command: command ? String(command).slice(0, 200) : null,
  });
  persist(state);
  return state;
}
