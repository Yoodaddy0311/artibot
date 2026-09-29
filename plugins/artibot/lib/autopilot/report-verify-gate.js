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
 * step would reorder them. Rule 6 alone reads a second field, the driver's own
 * `state.verifyResult`. REPORT has evidence only when all of these hold, and the
 * first that fails names the code (the order below is the precedence):
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
 *   6. `state.verifyResult` states no failure: none of `status: 'FAIL'`,
 *      `ok: false`, `passed: false` (the shapes `commands/autopilot.md` tells a
 *      driver to write). Any one → `VERIFY_RESULT_FAILED`. Rules 1-5 only see the
 *      status the driver passed to `recordPhaseResult`, so `status: 'done'` beside
 *      `verifyResult: {status: 'FAIL'}` passed them all. Last on purpose: a stale
 *      or unacknowledged VERIFY is reported as that, not as its result.
 *
 * ### Why rule 3 has no case-fold (decided 2026-09-29)
 *
 * A driver that records `'DONE'` is refused (`VERIFY_NOT_DONE`), and the
 * allowlist stays one entry long. The uppercase VERIFY rows found in stored
 * sessions (9 of the 22 driver-recorded VERIFY results in `state.phases`, in 8 of
 * the 21 sessions that have one; 46 distinct session ids in the
 * `runtime/autopilot` stores of the installed plugin caches and of this
 * checkout, 2026-09-29T04:13Z) all belong to sessions dated 2026-07-15..2026-08-10:
 * before the attempt journal (`e0565e46`, 2026-09-14) and before the lowercase
 * convention reached `commands/autopilot.md` (`fabee5cc`, 2026-09-15), so none of
 * those rows was ever an ACK this rule read. The 4 later sessions that have a
 * VERIFY result all recorded lowercase `done`. And
 * `recovery-record.js#isCleanVerify` requires `status === 'done'` exactly:
 * accepting `'DONE'` here alone would pass a VERIFY the recorder journals as
 * unclean. The likely source of the spelling is documentary — the Phase table in
 * that document prints `DONE` as a display label (inference, not observed) — so
 * the fix is in that document, not in this allowlist. If a post-AP-N1 session
 * shows an uppercase ACK anyway, widen by exactly that one entry, with the
 * measurement.
 *
 * IMPROVE is deliberately NOT a staleness trigger. It always runs after VERIFY
 * in the normal flow (`engine-state.js#PHASES`), so treating it as one would
 * block every session. The cost: this gate cannot see whether IMPROVE changed
 * code after VERIFY passed.
 *
 * ### Sessions with no VERIFY row (decided 2026-09-29, pinned by tests)
 *
 * An attempt is opened only by the engine's own phase runners
 * (`engine.js#runPhase4Verify`, `#runPhase2Execute`), never by
 * `recordPhaseResult`. So a session whose VERIFY was recorded without the engine
 * having handed it out has no VERIFY row, on any build. Three ways to get there:
 * a session stored before the attempt journal has no `attemptJournal` at all (the
 * loader backfills `[]`); one whose VERIFY ran before VERIFY was armed (AP-N1,
 * `e1e97dfa`, 2026-09-28) has a journal without a VERIFY row; and a driver that
 * writes phase results by hand has neither. All read `NO_VERIFY_ATTEMPT` and,
 * ON, pause once at REPORT. The gate does NOT fall back to the `state.phases`
 * VERIFY rows such sessions carry: that would be a second evidence source with
 * its own spelling problem (above) and no attempt id. The cost of switching ON
 * is one VERIFY re-run per such session (resume, acknowledge `done`, REPORT).
 * Measured in the same stores and at the same time: 20 sessions show REPORT
 * reached (a REPORT row, COMPLETED, or lastPhase REPORT) and 0 of those 20 hold
 * a non-empty attempt journal, including one dated 2026-09-29 that recorded
 * EXECUTE, VERIFY and REPORT `done` with no attempt. Which build ran that
 * session is not established here.
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
 * journal (plus, for rule 6, one result object): it cannot tell whether the
 * verification it accepts was a meaningful one. Nor can it stop a driver that
 * ignores the PAUSED it gets back from
 * `recordPhaseResult(state, { phase: 'REPORT', ... })` and reports the work
 * complete anyway: a refusal refuses the record, not the report. Rule 6 in
 * particular:
 *
 *   - It sees only the three explicit shapes. An absent `verifyResult`,
 *     `UNMEASURED`, free-form prose (`{lint: 'ok', test: '3 failed'}`), a
 *     lowercase `'fail'`, `ok: 'false'`, a nested layer result
 *     (`verifyResult.mcp.ok`) and a non-object all pass. How often a driver
 *     writes no explicit signal is the SH-06 recorder's measurement, not
 *     something this gate enforces.
 *   - `verifyResult` is not attempt-scoped: it is one slot. A FAIL left in it
 *     refuses the next REPORT even after a re-run VERIFY is acknowledged `done`
 *     (fail-closed; the driver must overwrite it — `commands/autopilot.md`), and a
 *     PASS left over from an earlier attempt cannot be told from this attempt's.
 *
 * ## Kill switch
 *
 * `autopilot.reportVerifyGate.enforce`, shipped `false`. OFF, the gate does
 * nothing at all — no tick, no state change — and the engine proceeds byte for
 * byte as before. ON, missing evidence pauses the session back to VERIFY.
 * Observation without enforcement is done offline, by running
 * {@link evaluateReportVerifyEvidence} over stored session states.
 *
 * The switch is read from `<pluginRoot>/artibot.config.json` on every call, and
 * an unreadable file (missing, or JSON that does not parse) reads OFF with no
 * tick and no warning — see {@link loadReportVerifyGateConfig}. A corrupted
 * config therefore disables enforcement silently; nothing here can tell that
 * from a deliberate OFF.
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
 *   STALE_BEFORE_EXECUTE: 'STALE_BEFORE_EXECUTE',
 *   VERIFY_RESULT_FAILED: 'VERIFY_RESULT_FAILED'}>}
 */
export const REPORT_VERIFY_CODES = Object.freeze({
  OK: 'ok',
  NO_VERIFY_ATTEMPT: 'NO_VERIFY_ATTEMPT',
  VERIFY_NOT_ACKED: 'VERIFY_NOT_ACKED',
  VERIFY_NOT_DONE: 'VERIFY_NOT_DONE',
  STALE_BEFORE_EXECUTE: 'STALE_BEFORE_EXECUTE',
  VERIFY_RESULT_FAILED: 'VERIFY_RESULT_FAILED',
});

/** The one result status that counts as a completed verification. */
const DONE_REASON = 'done';

/**
 * True when the driver's own result object states a failure in one of the three
 * explicit shapes `commands/autopilot.md` tells it to write and
 * `recovery-record.js#foldVerify` reads: `status: 'FAIL'`, `ok: false`,
 * `passed: false`. ANY one is enough. Strict equality on each, so `'fail'`,
 * `'false'`, prose and a nested layer result (`verifyResult.mcp.ok`) are not
 * failures here — the same allowlist of shapes, not a guess at intent.
 *
 * Where the two differ on purpose: `foldVerify` calls a contradiction
 * (`{status: 'PASS', ok: false}`) UNMEASURED, because a contradiction is not a
 * measurement. A gate has a different question — is there any explicit statement
 * that the verification failed? — and a PASS beside a FAIL does not retract it.
 *
 * @param {unknown} verifyResult - `state.verifyResult`, any shape.
 * @returns {boolean}
 */
function hasExplicitVerifyFail(verifyResult) {
  if (verifyResult === null || typeof verifyResult !== 'object' || Array.isArray(verifyResult)) return false;
  const r = /** @type {Record<string, unknown>} */ (verifyResult);
  return r.status === 'FAIL' || r.ok === false || r.passed === false;
}

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
 * file or broken JSON reads OFF — silently, with no tick and no warning, so a
 * corrupted config file disables enforcement without a trace. Never throws.
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
 * Pure: reads `state` (`attemptJournal`, `activePhaseAttempt` and, for rule 6,
 * `verifyResult`), never mutates it. The rule is in the module header.
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
  if (hasExplicitVerifyFail(state?.verifyResult)) return verdict(REPORT_VERIFY_CODES.VERIFY_RESULT_FAILED, started);
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
 *   - No evidence, session in a live phase (one of `livePhases`): pauses back to
 *     VERIFY ({@link pauseRecordedReport}).
 *   - No evidence, any other state — PAUSED (any reason), COMPLETED, ABORTED or
 *     an unknown value: nothing changes and one `kept` tick records the refusal.
 *     An allowlist, so a state added later is kept rather than paused: a REPORT
 *     claim never lifts a pause and never revives a finished session (resume's
 *     terminal no-op in `engine.js#resumeAutopilot` depends on that).
 *
 * `livePhases` is `engine-state.js#PHASES`, passed in by the caller because this
 * module cannot import engine-state.js (that module imports this one). Omitted —
 * or anything but a real array (null, a string, a Set) — it is treated as empty
 * and every refusal is `kept`: fail-closed, refused and never paused. Only an
 * array counts; a string would answer `includes` by substring.
 *
 * @param {object} state - Live session state (mutated only when pausing).
 * @param {{status?: unknown}} [payload] - The REPORT result being recorded.
 * @param {{enforce?: boolean}} [config] - The switch, injected by the caller.
 * @param {readonly string[]} [livePhases] - Phases a refusal may pause from.
 * @returns {boolean}
 */
export function refuseRecordedReport(state, payload, config, livePhases = []) {
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
  // Only a real array is a phase list (see the doc above).
  if (Array.isArray(livePhases) && livePhases.includes(state.phase)) {
    pauseRecordedReport(state, result, payload?.status);
    return true;
  }
  tick(state.sessionId, {
    phase: 'REPORT',
    type: 'report-verify-gate',
    level: 'warn',
    message: `REPORT 기록 거부 — ${state.phase} 상태 유지 (${result.code})`,
    data: { code: result.code, kept: true },
  });
  return true;
}
