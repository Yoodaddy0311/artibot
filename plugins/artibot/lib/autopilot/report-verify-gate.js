/**
 * REPORT verify-evidence gate — the AP-N1 residual absorbed by CA-13.
 *
 * AP-N1 armed VERIFY (`phase-attempt.js#ATTEMPT_ARMED_PHASES`) so a VERIFY
 * hand-off that never reported back is re-run or paused on resume. What it did
 * not cover is the other end: nothing at REPORT asked whether the work being
 * reported was ever verified. A session could reach `runPhase6Report` with no
 * VERIFY result at all, or with one that predates the latest EXECUTE, and
 * complete.
 *
 * ## Evidence rule (rule "B")
 *
 * The evidence is `state.attemptJournal` (rows written by
 * `phase-attempt.js#journalAttempt`: attemptId, phase, event, reason, at),
 * walked in ARRAY order — the order rows were appended — never by `at`, because
 * two rows written in the same millisecond carry equal timestamps and a clock
 * step would reorder them. REPORT has evidence only when all of these hold:
 *
 *   1. vS = the LAST `{phase: 'VERIFY', event: 'started'}` row exists.
 *      None → `NO_VERIFY_ATTEMPT`.
 *   2. A later `{event: 'acknowledged'}` row carries vS's attemptId.
 *      None → `VERIFY_NOT_ACKED`. An older VERIFY that WAS acknowledged does
 *      not count: the newer hand-off superseded it.
 *   3. That row's `reason` (the result status the driver reported) is exactly
 *      `'done'` — an allowlist of one. `'failed'`, `'DONE'`, and
 *      `'acknowledged-on-resume'` (`engine.js#settleOutstandingAttempt`: an
 *      operator saying the work landed, not a verification result) all give
 *      `VERIFY_NOT_DONE`.
 *   4. vS comes after the last `{phase: 'EXECUTE', event: 'started'}` row.
 *      Otherwise the verification is of code an EXECUTE has since replaced
 *      (goal-loop's corrective EXECUTE is the usual path) → `STALE_BEFORE_EXECUTE`.
 *   5. `state.activePhaseAttempt` is not a VERIFY slot. An occupied slot means a
 *      VERIFY hand-off is still outstanding → `VERIFY_NOT_ACKED`.
 *
 * IMPROVE is deliberately NOT a staleness trigger. It always runs after VERIFY
 * in the normal flow (`engine-state.js#PHASES`), so treating it as one would
 * block every session. The cost: this gate cannot see whether IMPROVE changed
 * code after VERIFY passed.
 *
 * ## Two entry points
 *
 * The engine path is `engine.js#runPhase6Report` → {@link gateReportOnVerify}.
 * The driver path is `engine-state.js#recordPhaseResult` → {@link refuseRecordedReport}:
 * a driver that records REPORT itself never enters runPhase6Report, and that
 * is most of the traffic — of 28 sessions that reached REPORT, only 1 went
 * through runPhase6Report (snapshot 2026-09-28T10:02Z). Both apply the same
 * rule and leave the same pause shape (PAUSED, lastPhase REPORT, pendingPhase
 * VERIFY).
 *
 * ON-only exception: on the driver path a REPORT without evidence lifts NO
 * pause, whatever its reason — the pause and its `pausedReason` stand. OFF keeps
 * the old lift (`engine-state.js#recordPhaseResult`, the PAUSED + lastPhase branch).
 *
 * ## What this gate cannot see (rules §9)
 *
 * A REPORT that reaches neither entry point — code that writes `state.phases`
 * or `state.phase` directly — is not judged. And the rule reads the attempt
 * journal only: it cannot tell whether the verification it accepts was a
 * meaningful one.
 *
 * ## Kill switch
 *
 * `autopilot.reportVerifyGate.enforce`, shipped `false`. OFF, the gate does
 * nothing at all — no tick, no state change — and the engine proceeds byte for
 * byte as before. ON, missing evidence pauses the session back to VERIFY.
 * Observation without enforcement is done offline, by running
 * {@link evaluateReportVerifyEvidence} over stored session states.
 *
 * @module lib/autopilot/report-verify-gate
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from '../core/platform.js';
import { mergeQueuedNotification, persist, tick } from './_engine-helpers.js';
import { notifyPause } from './notification.js';

/**
 * Config path of the kill switch. Exported so the firewall pin and the reader
 * share one spelling (precedent: `question-gate.js#QUESTION_GATE_ENFORCE_CONFIG_PATH`).
 * @type {string}
 */
export const REPORT_VERIFY_GATE_ENFORCE_CONFIG_PATH = 'autopilot.reportVerifyGate.enforce';

/**
 * The closed vocabulary of {@link evaluateReportVerifyEvidence} codes.
 * @type {Readonly<{OK: 'ok', NO_VERIFY_ATTEMPT: 'NO_VERIFY_ATTEMPT',
 *   VERIFY_NOT_ACKED: 'VERIFY_NOT_ACKED', VERIFY_NOT_DONE: 'VERIFY_NOT_DONE',
 *   STALE_BEFORE_EXECUTE: 'STALE_BEFORE_EXECUTE'}>}
 */
export const REPORT_VERIFY_CODES = Object.freeze({
  OK: 'ok',
  NO_VERIFY_ATTEMPT: 'NO_VERIFY_ATTEMPT',
  VERIFY_NOT_ACKED: 'VERIFY_NOT_ACKED',
  VERIFY_NOT_DONE: 'VERIFY_NOT_DONE',
  STALE_BEFORE_EXECUTE: 'STALE_BEFORE_EXECUTE',
});

/** The one result status that counts as a completed verification. */
const DONE_REASON = 'done';

/**
 * Resolve the kill switch from an already-read config object. Only the literal
 * `true` at {@link REPORT_VERIFY_GATE_ENFORCE_CONFIG_PATH} reads ON; `'true'`,
 * `1`, an absent key or a non-object config all read OFF.
 *
 * @param {unknown} cfg - Parsed `artibot.config.json`, or anything at all.
 * @returns {boolean}
 */
export function readReportVerifyGateEnforce(cfg) {
  return REPORT_VERIFY_GATE_ENFORCE_CONFIG_PATH
    .split('.')
    .reduce((node, key) => /** @type {any} */ (node)?.[key], cfg) === true;
}

/**
 * Read the kill switch straight off `<pluginRoot>/artibot.config.json`
 * (precedent: `recovery-transition.js#loadRecoveryTransitionConfig`). A missing
 * file or broken JSON reads OFF. Never throws.
 *
 * @returns {{enforce: boolean}}
 */
export function loadReportVerifyGateConfig() {
  try {
    const cfgPath = path.join(getPluginRoot(), 'artibot.config.json');
    return { enforce: readReportVerifyGateEnforce(JSON.parse(readFileSync(cfgPath, 'utf8'))) };
  } catch {
    return { enforce: false };
  }
}

/**
 * Build one verdict. `checkpointSha` is known only while a VERIFY slot is still
 * open: journal rows do not carry it, and the ACK clears the slot that did.
 * @param {string} code
 * @param {object|null} started - the vS journal row, when found
 * @param {object|null} slot - an open VERIFY `activePhaseAttempt`, when present
 * @returns {{ok: boolean, code: string, attemptId: string|null, checkpointSha: string|null}}
 */
function verdict(code, started = null, slot = null) {
  return {
    ok: code === REPORT_VERIFY_CODES.OK,
    code,
    attemptId: started?.attemptId ?? slot?.attemptId ?? null,
    checkpointSha: slot?.checkpointSha ?? null,
  };
}

/**
 * Decide whether the session holds VERIFY evidence for the work being reported.
 * Pure: reads `state`, never mutates it. The rule is in the module header.
 *
 * @param {object} state
 * @returns {{ok: boolean, code: string, attemptId: string|null, checkpointSha: string|null}}
 */
export function evaluateReportVerifyEvidence(state) {
  const journal = Array.isArray(state?.attemptJournal) ? state.attemptJournal : [];
  const active = state?.activePhaseAttempt;
  const slot = active && typeof active === 'object' && active.phase === 'VERIFY' ? active : null;
  const vIdx = journal.findLastIndex((row) => row?.phase === 'VERIFY' && row?.event === 'started');
  if (vIdx === -1) return verdict(REPORT_VERIFY_CODES.NO_VERIFY_ATTEMPT, null, slot);
  const started = journal[vIdx];
  const id = started.attemptId;
  // A null id could "match" any id-less ack row; only a real id can be acked.
  const ack = typeof id === 'string' && id
    ? journal.slice(vIdx + 1).find((row) => row?.event === 'acknowledged' && row?.attemptId === id)
    : undefined;
  if (!ack) return verdict(REPORT_VERIFY_CODES.VERIFY_NOT_ACKED, started, slot);
  if (ack.reason !== DONE_REASON) return verdict(REPORT_VERIFY_CODES.VERIFY_NOT_DONE, started, slot);
  const eIdx = journal.findLastIndex((row) => row?.phase === 'EXECUTE' && row?.event === 'started');
  if (vIdx < eIdx) return verdict(REPORT_VERIFY_CODES.STALE_BEFORE_EXECUTE, started, slot);
  if (slot) return verdict(REPORT_VERIFY_CODES.VERIFY_NOT_ACKED, started, slot);
  return verdict(REPORT_VERIFY_CODES.OK, started);
}

/**
 * Pause the session back to VERIFY. Same shape as `engine.js#maybePause`.
 *
 * `lastPhase` stays `'REPORT'` on purpose. Were it `'VERIFY'`, a bare
 * `recordPhaseResult(state, { phase: 'VERIFY', ... })` would lift the pause
 * (`engine-state.js#recordPhaseResult`, the PAUSED + lastPhase branch) without
 * opening a new attempt, the next REPORT would find the same missing evidence,
 * and the session would loop. `pendingPhase: 'VERIFY'` makes resume re-run
 * VERIFY, which opens a fresh attempt.
 *
 * The REPORT window is closed with a `phase-end` BEFORE the pause. Resume goes
 * to VERIFY, not back into this REPORT, so a window left open would read as a
 * crash inside REPORT (`replay.js#findUnterminatedPhases`) and the recovery
 * banner would announce a REPORT re-entry the engine never makes. Same shape as
 * the ACK's phase-end in `engine-state.js#recordPhaseResult` (`resultStatus`).
 *
 * @param {object} state - Live session state (mutated).
 * @param {{code: string, attemptId: string|null}} result
 * @returns {object} pause instruction
 */
function pauseForVerify(state, result) {
  const reason = `report-verify-evidence-missing:${result.code}`;
  tick(state.sessionId, {
    phase: 'REPORT',
    type: 'phase-end',
    level: 'info',
    message: `Phase 6 REPORT 보류 — VERIFY 근거 없음 (${result.code})`,
    data: { resultStatus: 'paused', code: result.code, attemptId: result.attemptId },
  });
  state.phase = 'PAUSED';
  state.lastPhase = 'REPORT';
  state.pendingPhase = 'VERIFY';
  state.pausedReason = reason;
  persist(state);
  tick(state.sessionId, {
    phase: 'REPORT',
    type: 'pause',
    level: 'warn',
    message: `Autopilot paused: ${reason}`,
    data: { code: result.code, attemptId: result.attemptId },
  });
  const note = notifyPause(state.sessionId, reason);
  return {
    type: 'pause',
    sessionId: state.sessionId,
    reason,
    code: result.code,
    attemptId: result.attemptId,
    notification: note,
    instructions: [
      'Autopilot 세션이 REPORT 직전에 일시정지되었습니다 — 현재 작업 결과에 대응하는 VERIFY 완료 근거가 없습니다.',
      `사유: ${reason}`,
      '/autopilot:resume <sessionId> 로 재개하면 VERIFY 부터 다시 실행합니다.',
    ],
  };
}

/**
 * The REPORT-entry gate. Returns null to let REPORT proceed, or a pause
 * instruction when the switch is on and the evidence is missing.
 *
 * OFF (the shipped default) is byte-invariant: no evaluation, no tick, no
 * persist — it returns null before touching anything, so events.ndjson and the
 * report's Phase Timeline are exactly what they were without the gate.
 *
 * @param {object} state - Live session state (mutated only when pausing).
 * @param {{enforce?: boolean}} [config] - Injectable for tests; omitted, it is
 *   read from `artibot.config.json`.
 * @returns {object|null}
 */
export function gateReportOnVerify(state, config = undefined) {
  if ((config ?? loadReportVerifyGateConfig())?.enforce !== true) return null;
  const result = evaluateReportVerifyEvidence(state);
  if (!result.ok) return pauseForVerify(state, result);
  // ON only: a passed gate leaves a trace, so an enforced run can later show
  // WHICH VERIFY attempt it accepted — the pause path is not the only record.
  tick(state?.sessionId, {
    phase: 'REPORT',
    type: 'report-verify-gate',
    level: 'info',
    message: `REPORT verify evidence: ${result.code}`,
    data: { code: result.code, attemptId: result.attemptId, enforced: true },
  });
  return null;
}

/**
 * Pause a driver-recorded REPORT back to VERIFY. The same four fields as
 * {@link pauseForVerify}, so the resume banner reads both paths alike — but no
 * `phase-end`: the driver path opens no REPORT window, so there is none to close.
 *
 * The notifier queues onto the session FILE, which the persist below rewrites
 * from this object; merging its payload into the live state first is what keeps
 * the entry (the same trap `engine-state.js#recordPhaseResult` closes for CA-03).
 *
 * @param {object} state - Live session state (mutated).
 * @param {{code: string, attemptId: string|null}} result
 * @param {unknown} claimedStatus - The status the driver reported for REPORT.
 */
function pauseRecordedReport(state, result, claimedStatus) {
  const reason = `report-verify-evidence-missing:${result.code}`;
  state.phase = 'PAUSED';
  state.lastPhase = 'REPORT';
  state.pendingPhase = 'VERIFY';
  state.pausedReason = reason;
  tick(state.sessionId, {
    phase: 'REPORT',
    type: 'pause',
    level: 'warn',
    message: `Autopilot paused: ${reason}`,
    data: {
      code: result.code,
      attemptId: result.attemptId,
      claimedStatus: typeof claimedStatus === 'string' ? claimedStatus : null,
    },
  });
  let note = null;
  try {
    note = notifyPause(state.sessionId, reason);
  } catch { /* the pause stands without its announcement */ }
  mergeQueuedNotification(state, note);
  persist(state);
}

/**
 * The driver-path gate, called by `engine-state.js#recordPhaseResult` before a
 * REPORT result is recorded. Returns true when the REPORT was refused — the
 * caller then records nothing and returns.
 *
 *   - Switch OFF: returns false before evaluating anything. No tick, no write.
 *   - Evidence OK: one `report-verify-gate` tick (the engine path's pass trace,
 *     plus `via`), returns false, and the caller records as before.
 *   - No evidence, session already PAUSED (any reason): nothing changes — the
 *     pause and its reason stand — and one `kept` tick records the refusal.
 *     A REPORT claim is therefore never what lifts a pause while the switch is on.
 *   - No evidence otherwise: pauses back to VERIFY ({@link pauseRecordedReport}).
 *
 * @param {object} state - Live session state (mutated only when pausing).
 * @param {{status?: unknown}} [payload] - The REPORT result being recorded.
 * @param {{enforce?: boolean}} [config] - The switch, injected by the caller.
 * @returns {boolean}
 */
export function refuseRecordedReport(state, payload, config) {
  if (config?.enforce !== true) return false;
  const result = evaluateReportVerifyEvidence(state);
  if (result.ok) {
    tick(state?.sessionId, {
      phase: 'REPORT',
      type: 'report-verify-gate',
      level: 'info',
      message: `REPORT verify evidence: ${result.code}`,
      data: { code: result.code, attemptId: result.attemptId, enforced: true, via: 'recordPhaseResult' },
    });
    return false;
  }
  if (state.phase === 'PAUSED') {
    tick(state.sessionId, {
      phase: 'REPORT',
      type: 'report-verify-gate',
      level: 'warn',
      message: `REPORT 기록 거부 — 일시정지 유지 (${result.code})`,
      data: { code: result.code, kept: true },
    });
    return true;
  }
  pauseRecordedReport(state, result, payload?.status);
  return true;
}
