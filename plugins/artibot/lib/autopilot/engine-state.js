/**
 * Autopilot engine — state record/mutation helpers.
 *
 * Pure extraction from engine.js (no behavior change). These functions mutate
 * and persist session state but are independent of phase-flow orchestration.
 * One-directional: this module never imports engine.js.
 *
 * @module lib/autopilot/engine-state
 */

import { mergeQueuedNotification, persist, recordPhase, tick } from './_engine-helpers.js';
import { appendLesson } from './memory.js';
import { ackPhaseAttempt } from './phase-attempt.js';
import { recordRecoveryDecision } from './recovery-record.js';
import { applyRecoveryTransition, loadRecoveryTransitionConfig } from './recovery-transition.js';

/**
 * Phase names in canonical order.
 *
 * EVALUATE (v4.6.0) sits between IMPROVE and REPORT and is a no-op
 * "gate" for legacy sessions (no Goal Contract). When a Goal Contract
 * is present, runPhaseGoalEvaluate may instead emit a re-EXECUTE
 * instruction to start another iteration.
 */
export const PHASES = Object.freeze([
  'INTAKE',
  'PLAN',
  'EXECUTE',
  'CROSS_CHECK',
  'VERIFY',
  'IMPROVE',
  'EVALUATE',
  'REPORT',
]);

/**
 * Determine the next phase to run from the current phase label.
 * @param {string} current
 * @returns {string|null}
 */
export function nextPhaseAfter(current) {
  if (current === 'COMPLETED' || current === 'ABORTED') return null;
  if (current === 'PAUSED') return null;
  const idx = PHASES.indexOf(current);
  if (idx === -1) return 'PLAN';
  if (idx >= PHASES.length - 1) return null;
  return PHASES[idx + 1];
}

/**
 * Mark `phase` as the phase this session has just entered.
 *
 * `state.phase` alone is ambiguous — it has to mean "most recently
 * entered/completed", and every reader that wants "what runs next" must go
 * through {@link nextTarget}. Entering a phase therefore clears any explicit
 * `pendingPhase` override: the override existed to redirect the runner that is
 * now running, so keeping it would redirect the *next* one as well.
 *
 * @param {object} state - Live session state (mutated).
 * @param {string} phase
 * @returns {object} mutated state
 */
export function enterPhase(state, phase) {
  if (!state) throw new TypeError('state required');
  state.phase = phase;
  state.pendingPhase = null;
  return state;
}

/**
 * Resolve the phase a resume should run next. Pure — reads, never mutates.
 *
 * `pendingPhase` is the explicit answer and wins when it names a real phase;
 * everything else is the v2 derivation kept verbatim so a state written before
 * this field existed resumes exactly where it used to.
 *
 * @param {object} state
 * @returns {string|null} phase label, or null when the session is terminal
 */
export function nextTarget(state) {
  const phase = state?.phase;
  if (phase === 'COMPLETED' || phase === 'ABORTED') return null;
  const pending = state?.pendingPhase;
  if (typeof pending === 'string' && PHASES.includes(pending)) return pending;
  if (phase === 'PAUSED') return state?.lastPhase || 'PLAN';
  return nextPhaseAfter(phase) || phase;
}

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
 * **It is also the SH-06 recovery-recording point** for `VERIFY`, for the same
 * reason: a verify *result* only exists here. `recovery-record.js` writes a
 * judgement into `state.recoveryJournal` and changes no transition. CA-03 — the
 * wiring that lets that judgement steer `pendingPhase` — also lives here, but
 * behind the `autopilot.recovery.transitionFromVerdict` gate: OFF (the default)
 * leaves every field and event exactly as the Observe stage wrote them. When it
 * is ON and the verdict pauses, the returned notification's queue payload is
 * merged into the live state here, before the persist below — see the comment
 * at that call for why the merge, and not a later announcement, is what makes
 * the entry durable.
 *
 * @param {object} state
 * @param {{ phase: string, status: string, [k: string]: any }} payload
 * @param {{transitionFromVerdict?: boolean}} [config] - CA-03 gate, injectable
 *   for tests (precedent: `engine.js#resolveExecuteRunner(state, config)`).
 *   Omitted, it is read from `artibot.config.json` — and only when a journal row
 *   exists, so the clean-VERIFY path does no I/O.
 * @returns {object} mutated state
 */
export function recordPhaseResult(state, payload = {}, config = undefined) {
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
  // A result for a phase the session is paused *on* is what lifts the pause:
  // the work is now accounted for, so `phase` becomes that phase (completed)
  // and the runner target advances past it. Without this, resume would re-read
  // `PAUSED` + `lastPhase` and hand the same phase out a second time (AP-01).
  // The plain in-flow case (`state.phase === phase`, nothing acked) leaves
  // `pendingPhase` alone so an explicit target — goal-loop's corrective
  // EXECUTE — survives a later driver report for the phase that set it.
  if (acked || (state.phase === 'PAUSED' && state.lastPhase === phase)) {
    state.phase = phase;
    state.pendingPhase = nextPhaseAfter(phase);
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
  // SH-06 recording point (Observe stage). A VERIFY *result* is the first
  // moment the engine knows whether verification succeeded, so it is where the
  // recovery judgement is journalled. The recorder never throws into this ACK.
  // With the CA-03 gate OFF (default) this stays recording-only and the fixed
  // transition above is untouched; with it ON, `applyRecoveryTransition` moves
  // `pendingPhase` (or pauses) right after the row is written.
  if (phase === 'VERIFY') {
    const row = recordRecoveryDecision(state, { ...rest, phase, status, fixedNext: nextPhaseAfter(phase) });
    // CA-03: only a journalled failure can steer the transition, and only when
    // `autopilot.recovery.transitionFromVerdict` is true. OFF leaves every field
    // and event exactly as the Observe stage wrote them; the config is not even
    // read unless a row exists.
    if (row) {
      const cfg = config ?? loadRecoveryTransitionConfig();
      if (cfg?.transitionFromVerdict === true) {
        const applied = applyRecoveryTransition(state, row, cfg);
        // The pause notification queues onto the session FILE from inside that
        // call, i.e. before the persist below rewrites the file from this
        // object. Taking the returned payload into the live queue is what makes
        // the persist carry it instead of erasing it — and unlike announcing
        // after the persist, it also survives the next persist of this same
        // state, because the entry then lives in the object every later write
        // is made from.
        // Narrow on purpose: an unapplied gate and a phase-advancing action
        // never reach the merge, and a notifier that threw reaches it with
        // `notification === null`, which merges nothing. So the only path that
        // differs from before is an applied PAUSED whose notification was
        // actually delivered.
        if (applied?.applied === true && applied.next === 'PAUSED') {
          mergeQueuedNotification(state, applied.notification);
        }
      }
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
  state.pendingPhase = state.lastPhase || null;
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
