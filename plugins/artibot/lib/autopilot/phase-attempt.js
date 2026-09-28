/**
 * Durable phase attempts — the ACK half of autopilot crash recovery.
 *
 * ## Why this exists (the gap NDJSON pairing cannot close)
 *
 * `replay.js#findUnterminatedPhases` finds a `phase-start` with no matching
 * `phase-end`. That catches a process that died *inside* a phase body. It
 * could not catch the case that actually matters, because the delegating
 * phases used to record `phase-end` at **delegation** time, not at completion
 * — and the unarmed ones still do:
 *
 *   runPhase2Execute (before arming):  tick(phase-start) → build instruction
 *                      → tick(phase-end) → return  ... and only THEN does the
 *                      real work happen, in a team the engine no longer controls.
 *
 * So a crash during the actual work landed *after* `phase-end` was written.
 * The pairing model saw a closed phase and reported a clean session.
 * Five phases delegate this way (`PLAN`, `EXECUTE`, `CROSS_CHECK`, `VERIFY`,
 * `IMPROVE`); the unarmed ones still log "위임 완료" at hand-off, the armed ones
 * ({@link ATTEMPT_ARMED_PHASES}) no longer do. `INTAKE` and `REPORT` genuinely
 * finish in-process and are not affected.
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
 * Phases that arm a durable attempt: `EXECUTE` and `VERIFY`.
 *
 * All five delegating phases have the same blind spot; each entry here was
 * armed for its own reason, and arming alone is not enough — the phase runner
 * must open the attempt instead of writing `phase-end` at hand-off
 * (`engine.js#runPhase2Execute`, `#runPhase4Verify`).
 *
 *   - `EXECUTE` — an un-acknowledged re-run can write code twice, the failure
 *     the risk lens called worst. Not allowlisted, so recovery pauses.
 *   - `VERIFY` — the earlier reason for leaving it out ("re-running is cheap")
 *     was true but beside the point: resume never re-ran it. A crash after the
 *     hand-off let resume step to `nextPhaseAfter('VERIFY')`, and the session
 *     could complete with `verifyResult: null`. It is already in
 *     {@link ATTEMPT_RERUN_ALLOWLIST}, so once armed it re-runs unattended —
 *     once per unacknowledged streak, then pauses.
 *
 * Not armed — each out of scope for the change that armed VERIFY, not judged
 * safe to leave unarmed. Widening is a separate decision: one entry here plus
 * the runner change above.
 *
 *   - `PLAN` — not allowlisted either, so arming it would pause, not re-run.
 *   - `CROSS_CHECK` — allowlisted, so arming would re-run it; not yet decided.
 *   - `IMPROVE` — writes `improvements`/`futurePlans` lessons on its result;
 *     re-run safety is unassessed.
 *
 * @type {ReadonlySet<string>}
 */
export const ATTEMPT_ARMED_PHASES = new Set(['EXECUTE', 'VERIFY']);

/**
 * Phases whose un-acknowledged attempt may be re-run automatically.
 *
 * **Allowlist. Membership means "safe to redo unattended."** A phase qualifies
 * only if redoing it cannot duplicate a durable side effect that already
 * landed. `EXECUTE` is excluded on purpose and must stay excluded.
 *
 *   - `CROSS_CHECK` — a review pass that reads and reports.
 *   - `VERIFY` — NOT read-only: its instruction re-runs `npm run ci`, calls
 *     `build-error-resolver` (which edits code) on failure, and increments
 *     `state.counters.buildFailures`/`testFailures`
 *     (`engine.js#runPhase4Verify`). It is here anyway because a redo is "run
 *     ci again, fix further only if it still fails" — a repair that already
 *     landed makes ci pass, so nothing is committed twice (inference: the
 *     driver's behaviour is not observed here). A doubled counter moves the
 *     `safety.js#shouldPause` threshold closer, i.e. the conservative direction.
 *     Unbounded repetition is stopped by the one-re-run cap in
 *     {@link reconcileAttemptOnResume}.
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
 * Append one row to the additive `state.attemptJournal`.
 *
 * `activePhaseAttempt` is a single slot: it answers "is something outstanding
 * right now" and is erased by the very ACK a post-mortem wants to read. The
 * journal is the append-only half — it keeps who handed what out, and how each
 * hand-off ended, after the slot is gone.
 *
 * @param {object} state - Live session state (mutated).
 * @param {{attemptId?: string|null, phase?: string|null,
 *          event?: 'started'|'acknowledged'|'paused'|'rerun',
 *          from?: string|null, to?: string|null, reason?: string|null}} entry
 * @returns {object|null} the appended row, or null for a non-object state
 */
export function journalAttempt(state, entry = {}) {
  if (!state || typeof state !== 'object') return null;
  if (!Array.isArray(state.attemptJournal)) state.attemptJournal = [];
  const row = {
    attemptId: entry.attemptId ?? null,
    phase: entry.phase ?? null,
    event: entry.event ?? null,
    from: entry.from ?? null,
    to: entry.to ?? null,
    reason: entry.reason ?? null,
    at: new Date().toISOString(),
  };
  state.attemptJournal.push(row);
  return row;
}

/**
 * True when `attemptId` already has an `acknowledged` row.
 * @param {object} state
 * @param {string} attemptId
 * @returns {boolean}
 */
function alreadyAcknowledged(state, attemptId) {
  const journal = state?.attemptJournal;
  if (!Array.isArray(journal)) return false;
  return journal.some((row) => row?.event === 'acknowledged' && row?.attemptId === attemptId);
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
  journalAttempt(state, {
    attemptId: attempt.attemptId,
    phase: attempt.phase,
    event: 'started',
    from: typeof state.phase === 'string' ? state.phase : null,
    to: attempt.phase,
  });
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
  // Keyed on attemptId, not on the slot: the slot is cleared below, so a
  // duplicate ACK of a re-installed attempt is the only way here twice, and it
  // must not double-count a single hand-off in the post-mortem record.
  if (!alreadyAcknowledged(state, attempt.attemptId)) {
    journalAttempt(state, {
      attemptId: attempt.attemptId,
      phase: attempt.phase,
      event: 'acknowledged',
      from: attempt.phase,
      reason: acked.resultStatus,
    });
  }
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
 *   `rerun` — allowlisted phase, safe to redo unattended, and not already
 *     re-run since that phase's last acknowledgement.
 *   `pause` — everything else. The default, and where EXECUTE always lands.
 */
export function reconcileAttemptOnResume(state) {
  const attempt = state?.activePhaseAttempt;
  if (!attempt || typeof attempt !== 'object') return { action: 'none' };
  if (attempt.status !== ATTEMPT_STATUS.STARTED) return { action: 'none' };
  const phase = typeof attempt.phase === 'string' ? attempt.phase : null;
  if (!phase) return { action: 'none' };

  if (ATTEMPT_RERUN_ALLOWLIST.has(phase)) {
    // One unattended re-run per unacknowledged streak. A driver that never
    // reports the result (or reports it before the runner) would otherwise
    // re-run the phase on every resume, forever; the second crash asks a human.
    if (!rerunSpent(state, phase)) return { action: 'rerun', attempt, note: buildRerunNote(attempt) };
    return { action: 'pause', attempt, note: buildPauseNote(attempt, { rerunSpent: true }) };
  }
  return { action: 'pause', attempt, note: buildPauseNote(attempt) };
}

/**
 * True when `phase` has a `rerun` row after its last `acknowledged` row — i.e.
 * the current unacknowledged streak already used its automatic re-run. An ACK
 * ends the streak, so a later, unrelated crash of the same phase gets its own.
 * @param {object} state
 * @param {string} phase
 * @returns {boolean}
 */
function rerunSpent(state, phase) {
  const journal = Array.isArray(state?.attemptJournal) ? state.attemptJournal : [];
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    const row = journal[i];
    if (row?.phase !== phase) continue;
    if (row.event === 'acknowledged') return false;
    if (row.event === 'rerun') return true;
  }
  return false;
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
 * The reason sentence differs by cause: a non-allowlisted phase (EXECUTE) is
 * never re-run because it could commit landed work twice; an allowlisted one
 * reaches here only after its one automatic re-run also went unacknowledged.
 *
 * @param {object} attempt
 * @param {{rerunSpent?: boolean}} [opts]
 * @returns {string}
 */
export function buildPauseNote(attempt, { rerunSpent: spent = false } = {}) {
  const started = attempt.startedAt ? ` (${attempt.startedAt})` : '';
  const base = attempt.checkpointSha
    ? `기준 커밋 ${attempt.checkpointSha.slice(0, 7)}`
    : '기준 커밋 기록 없음';
  const reason = spent
    ? '이미 한 번 자동 재실행했는데도 완료 보고가 없어, 무한 재실행을 막기 위해서입니다'
    : '이미 반영된 작업을 다시 커밋할 수 있기 때문입니다';
  return `이전 세션이 ${attempt.phase} 작업을 위임한 뒤 완료 보고 없이 중단됐습니다${started}. `
    + `${base}. 자동 재실행하지 않습니다 — ${reason}. `
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
  // VERIFY is not side-effect free (see ATTEMPT_RERUN_ALLOWLIST), so it gets
  // its own reason; every other allowlisted phase keeps the original wording.
  const why = attempt.phase === 'VERIFY'
    ? 'ci 를 다시 돌리고 실패할 때만 추가 수정하는 단계라 자동으로 다시 진행합니다(자동 재실행은 1회까지)'
    : '재실행해도 부작용이 없는 단계라 자동으로 다시 진행합니다';
  return `이전 세션이 ${attempt.phase} 단계에서 완료 보고 없이 중단됐습니다${started}. `
    + `${attempt.phase} 는 ${why}.`;
}
