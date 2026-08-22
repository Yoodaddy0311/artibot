/**
 * Durable phase attempts — the ACK half of autopilot crash recovery.
 *
 * ## Why this exists (the gap NDJSON pairing cannot close)
 *
 * `replay.js#findUnterminatedPhases` finds a `phase-start` with no matching
 * `phase-end`. That catches a process that died *inside* a phase body. It
 * cannot catch the case that actually matters, because the delegating phases
 * record `phase-end` at **delegation** time, not at completion:
 *
 *   runPhase2Execute:  tick(phase-start) → build instruction → tick(phase-end)
 *                      → return  ... and only THEN does the real work happen,
 *                      in a team the engine no longer controls.
 *
 * So a crash during the actual EXECUTE work lands *after* `phase-end` was
 * written. The pairing model sees a closed phase and reports a clean session.
 * Five phases share this shape (`PLAN`, `EXECUTE`, `CROSS_CHECK`, `VERIFY`,
 * `IMPROVE` all log "위임 완료"); `INTAKE` and `REPORT` genuinely finish
 * in-process and are not affected.
 *
 * An attempt closes that gap by making completion an **explicit
 * acknowledgement** rather than something inferred from a log line: the engine
 * writes a durable `activePhaseAttempt` before handing work out, and only the
 * result callback clears it. A slot still occupied on resume means the work
 * was handed out and never came back.
 *
 * ## Why re-running is opt-in, never the default
 *
 * The worst outcome here is not a missed detection — it is an unattended
 * re-run of EXECUTE producing a second set of commits for work that already
 * landed. So recovery is an **allowlist**: a phase is auto-re-run only if it
 * is named in {@link ATTEMPT_RERUN_ALLOWLIST}. Anything else pauses and asks a
 * human. A deny-list would fail open the moment a new phase is armed, which is
 * exactly the direction this must not fail.
 *
 * Layer 2 (auxiliary): imports nothing above L2.
 *
 * @module lib/autopilot/phase-attempt
 */

import { randomUUID } from 'node:crypto';

/**
 * Phases that arm a durable attempt. Deliberately just `EXECUTE` for now.
 *
 * All five delegating phases have the same blind spot, but only EXECUTE's
 * un-acknowledged re-run can write code twice — the failure the risk lens
 * called worst. Arming the other four would double the state machine for
 * phases whose re-run is cheap and idempotent, so this stays minimal and the
 * mechanism stays generic: arming another phase is one entry here, not a code
 * change.
 *
 * @type {ReadonlySet<string>}
 */
export const ATTEMPT_ARMED_PHASES = new Set(['EXECUTE']);

/**
 * Phases whose un-acknowledged attempt may be re-run automatically.
 *
 * **Allowlist. Membership means "safe to redo unattended."** A phase qualifies
 * only if redoing it cannot produce a durable side effect that already exists
 * — in practice, only review passes that read and report. `EXECUTE` is
 * excluded on purpose and must stay excluded.
 *
 * @type {ReadonlySet<string>}
 */
export const ATTEMPT_RERUN_ALLOWLIST = new Set(['CROSS_CHECK', 'VERIFY']);

/** Attempt lifecycle states. */
export const ATTEMPT_STATUS = Object.freeze({
  STARTED: 'started',
  COMMITTED: 'committed',
});

/**
 * True when `phase` should arm a durable attempt.
 *
 * @param {string} phase
 * @returns {boolean}
 */
export function isAttemptArmed(phase) {
  return typeof phase === 'string' && ATTEMPT_ARMED_PHASES.has(phase);
}

/**
 * Read the last recorded checkpoint SHA, or null.
 *
 * Stored on the attempt so a human deciding whether to re-run can see the
 * commit the handed-out work started from.
 *
 * @param {object} state
 * @returns {string|null}
 */
function lastCheckpointSha(state) {
  const checkpoints = Array.isArray(state?.checkpoints) ? state.checkpoints : [];
  for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
    const sha = checkpoints[i]?.sha;
    if (typeof sha === 'string' && sha) return sha;
  }
  return null;
}

/**
 * Open a durable attempt on `state` and return it.
 *
 * Additive: writes only `state.activePhaseAttempt`, so the schema version is
 * unchanged and an older reader simply ignores the field. Persisting is the
 * caller's job — the engine already persists immediately after, and doing it
 * here would hide a second write.
 *
 * @param {object} state - Live session state (mutated).
 * @param {{phase: string, runner?: string|null}} spec
 * @returns {{attemptId: string, phase: string, runner: string|null,
 *            status: string, checkpointSha: string|null, startedAt: string}}
 */
export function openPhaseAttempt(state, spec) {
  const attempt = {
    // randomUUID, not a counter or a timestamp: two attempts opened in the
    // same millisecond (resume storms, tests) must never collide, because the
    // ACK matches on this id.
    attemptId: randomUUID(),
    phase: spec.phase,
    runner: spec.runner ?? null,
    status: ATTEMPT_STATUS.STARTED,
    checkpointSha: lastCheckpointSha(state),
    startedAt: new Date().toISOString(),
  };
  state.activePhaseAttempt = attempt;
  return attempt;
}

/**
 * Acknowledge the open attempt for `phase` and clear the slot.
 *
 * No-op returning null when there is no open attempt, or when the open attempt
 * belongs to a different phase — so a driver acknowledging PLAN can never
 * clear an EXECUTE attempt that is still outstanding.
 *
 * @param {object} state - Live session state (mutated).
 * @param {{phase?: string, status?: string}} [payload]
 * @returns {object|null} The acknowledged attempt, or null when nothing matched.
 */
export function ackPhaseAttempt(state, payload = {}) {
  const attempt = state?.activePhaseAttempt;
  if (!attempt || typeof attempt !== 'object') return null;
  if (attempt.phase !== payload.phase) return null;
  const acked = {
    ...attempt,
    status: ATTEMPT_STATUS.COMMITTED,
    committedAt: new Date().toISOString(),
    resultStatus: typeof payload.status === 'string' ? payload.status : null,
  };
  // Clearing the slot is what prevents a permanent recovery loop: a session
  // that completed normally must produce zero recovery notes on resume.
  state.activePhaseAttempt = null;
  return acked;
}

/**
 * Decide what resume should do about an outstanding attempt.
 *
 * @param {object} state - Live session state (not mutated).
 * @returns {{action: 'none'}
 *          |{action: 'rerun', attempt: object, note: string}
 *          |{action: 'pause', attempt: object, note: string}}
 *   `none` — nothing was outstanding; resume proceeds untouched.
 *   `rerun` — allowlisted phase, safe to redo unattended.
 *   `pause` — everything else. The default, and where EXECUTE always lands.
 */
export function reconcileAttemptOnResume(state) {
  const attempt = state?.activePhaseAttempt;
  if (!attempt || typeof attempt !== 'object') return { action: 'none' };
  if (attempt.status !== ATTEMPT_STATUS.STARTED) return { action: 'none' };
  const phase = typeof attempt.phase === 'string' ? attempt.phase : null;
  if (!phase) return { action: 'none' };

  if (ATTEMPT_RERUN_ALLOWLIST.has(phase)) {
    return { action: 'rerun', attempt, note: buildRerunNote(attempt) };
  }
  return { action: 'pause', attempt, note: buildPauseNote(attempt) };
}

/**
 * Korean recovery banner for a paused, unacknowledged attempt.
 *
 * Says what was handed out, from which commit, and **every way out** — all
 * three are in-band and reachable. An earlier version named only
 * `recordPhaseResult`, which left a reader who could not use it with no
 * documented exit; a banner whose advice dead-ends is worse than none, because
 * the pause repeats on every subsequent resume.
 *
 * @param {object} attempt
 * @returns {string}
 */
export function buildPauseNote(attempt) {
  const started = attempt.startedAt ? ` (${attempt.startedAt})` : '';
  const base = attempt.checkpointSha
    ? `기준 커밋 ${attempt.checkpointSha.slice(0, 7)}`
    : '기준 커밋 기록 없음';
  return `이전 세션이 ${attempt.phase} 작업을 위임한 뒤 완료 보고 없이 중단됐습니다${started}. `
    + `${base}. 자동 재실행하지 않습니다 — 이미 반영된 작업을 다시 커밋할 수 있기 때문입니다. `
    + `먼저 작업 결과가 실제로 반영됐는지 확인한 뒤 셋 중 하나를 선택하세요: `
    + `(1) 반영됨 · 결과를 기록할 수 있다 → recordPhaseResult(state, { phase: '${attempt.phase}', status: 'done' }) `
    + `(2) 반영됨 · 결과를 기록할 수 없다 → resumeAutopilot(sessionId, { ackOutstandingAttempt: true }) 로 승인 후 재개 `
    + `(3) 반영 안 됨 또는 판단 불가 → /autopilot:abort 로 세션을 종료하고 새로 시작.`;
}

/**
 * Korean recovery banner for an allowlisted attempt being re-run.
 *
 * @param {object} attempt
 * @returns {string}
 */
export function buildRerunNote(attempt) {
  const started = attempt.startedAt ? ` (${attempt.startedAt})` : '';
  return `이전 세션이 ${attempt.phase} 단계에서 완료 보고 없이 중단됐습니다${started}. `
    + `${attempt.phase} 는 재실행해도 부작용이 없는 단계라 자동으로 다시 진행합니다.`;
}
