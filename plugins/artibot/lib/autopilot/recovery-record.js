/**
 * Recovery decision RECORDER — Observe stage, zero behavior change (SH-06).
 *
 * This module writes a judgement about a failed VERIFY and nothing else. It
 * does not touch `state.phase`, `state.pendingPhase`, `state.phases` or any
 * instruction, so the fixed `VERIFY -> IMPROVE` transition
 * (`engine.js#runPhase4Verify`, `engine-state.js#nextPhaseAfter`) is exactly
 * as it was. Flipping that transition to the recommendation recorded here is
 * CA-03's job, deliberately separate: the switch should be made against a
 * measured denominator rather than a guess, and this journal is that
 * denominator.
 *
 * ── Who reads this ────────────────────────────────────────────────────────
 * `state.recoveryJournal` is the input CA-03 will read, so the row carries what
 * a later transition needs (`class`, `action`, `target`, `reason`) plus what an
 * Observe-stage audit needs (`verdictRaw` beside the adapted `verdict`,
 * `verificationStatus`, `fixedNext`). `divergent` is always `true` today — the
 * fixed transition goes to IMPROVE whatever the recommendation is — and exists
 * so the vocabulary is stable before CA-03 starts writing `false`.
 *
 * ── Three rules that are not judgement calls ──────────────────────────────
 *  1. **PASS is not recorded.** `failure-classifier.js#classify` names PASS a
 *     caller precondition violation, so a clean VERIFY writes zero rows and
 *     zero telemetry lines.
 *  2. **Only an explicit signal is a measurement** ({@link foldVerify}), and
 *     the resulting input-deficit rate IS the Observe-stage measurement.
 *  3. **Never throw** ({@link journalRecordFailure}) — the caller is the phase
 *     ACK point, and the fail-stuck F02 fixed starts with a throw here.
 *
 * Layer: L2, importing `lib/recovery` and `lib/review` (L2 siblings) and
 * nothing higher. It does NOT import `engine-state.js` — that module imports
 * this one — so `fixedNext` arrives through the payload rather than being
 * recomputed, keeping the dependency one-directional.
 *
 * @module lib/autopilot/recovery-record
 */

import { tick } from './_engine-helpers.js';
import { classify } from '../recovery/failure-classifier.js';
import { decide } from '../recovery/recovery-controller.js';
import { foldLegacyToken } from '../review/independent-reviewer.js';

/**
 * The `onFailure` payload `engine.js#runPhase4Verify` attaches to its
 * instruction. The engine returns it to the driver and never stores it, so the
 * controller cannot read it off `state`; this constant is the reconstruction.
 * `agent` is omitted on purpose — `decide()` does not consult it, and copying a
 * field nobody reads invites it to drift. Pinned against the live instruction
 * in `tests/autopilot/recovery-record.test.js`, so an engine payload change
 * goes red rather than silently giving the ladder a stale budget.
 */
export const VERIFY_ON_FAILURE = Object.freeze({ retryLimit: 3, escalateTo: 'pause' });

/** The three statuses `classify()` accepts under `verification.status`. */
const EXPLICIT_STATUSES = Object.freeze(['PASS', 'FAIL', 'UNMEASURED']);

/**
 * Fold a driver-written `state.verifyResult` into a verification status.
 *
 * ALLOWLIST of three explicit shapes, checked independently: `status` spelled
 * exactly `PASS`/`FAIL`/`UNMEASURED`, `ok` as a real boolean, `passed` as a
 * real boolean.
 *
 * Anything else — free-form prose, the `mcp` slot alone, an exit code, a
 * non-object — is `UNMEASURED`, and so are two explicit signals that disagree:
 * a contradiction is not a measurement. Pure, and never reads nested objects —
 * `verifyResult.mcp.ok` is one layer's result, and treating it as the fold
 * would let a single MCP check speak for lint, typecheck, test and build.
 *
 * @param {unknown} verifyResult - `state.verifyResult`, any shape.
 * @returns {'PASS'|'FAIL'|'UNMEASURED'}
 */
export function foldVerify(verifyResult) {
  if (verifyResult === null || typeof verifyResult !== 'object' || Array.isArray(verifyResult)) {
    return 'UNMEASURED';
  }
  const signals = [];
  if (EXPLICIT_STATUSES.includes(verifyResult.status)) signals.push(verifyResult.status);
  if (typeof verifyResult.ok === 'boolean') signals.push(verifyResult.ok ? 'PASS' : 'FAIL');
  if (typeof verifyResult.passed === 'boolean') signals.push(verifyResult.passed ? 'PASS' : 'FAIL');

  const distinct = [...new Set(signals)];
  return distinct.length === 1 ? distinct[0] : 'UNMEASURED';
}

/**
 * Fold one legacy verdict token to a canonical verdict, or `null`.
 *
 * Delegates to `lib/review/independent-reviewer.js#foldLegacyToken`, which
 * resolves the token against `ADAPTER_ROWS` — the in-module mirror of
 * `schemas/verdict-adapter-map.json`, kept identical by
 * `tests/review/independent-reviewer.drift.test.js`. There is therefore no
 * mapping table in this file and no second place to update.
 *
 * `null` covers all three refusals the map specifies — unmapped token
 * (`rules.unmapped_token: reject`), the ambiguous `SPEC_FAIL` row, and two
 * sources disagreeing on one spelling — and sends `classify()` to the
 * verification fold or to `unknown`, never to a silent PASS. The driver writes
 * `"pass" | "warn" | "fail"` (`engine.js#runPhase3CrossCheck`) while schema-v1
 * spells the middle token `warning`, so `warn` folds to `null` by design.
 *
 * @param {unknown} legacyToken - Typically `state.crossCheck.verdict`.
 * @returns {string|null} A canonical verdict, or null when undetermined.
 */
export function adaptVerdict(legacyToken) {
  if (typeof legacyToken !== 'string') return null;
  return foldLegacyToken(legacyToken).verdict ?? null;
}

/** Non-negative integer, or 0. Counters are advisory and must never throw. */
function intOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** How many journal rows already carry this class, plus the current one. */
function sameClassAttempts(journal, failureClass) {
  if (!Array.isArray(journal)) return 1;
  return journal.filter((r) => r !== null && typeof r === 'object' && r.class === failureClass)
    .length + 1;
}

/**
 * Append to the journal, creating it when absent or corrupt. Lazy init rather
 * than a `session-store.js#migrateState` backfill: the field is additive, the
 * schema version does not move, and an older session simply grows the array on
 * its first record — so `session-store.js` stays untouched by this change.
 * @param {object} state
 * @param {object} row
 * @returns {object} the row
 */
function pushJournal(state, row) {
  if (!Array.isArray(state.recoveryJournal)) state.recoveryJournal = [];
  state.recoveryJournal.push(row);
  return row;
}

/**
 * Last-resort journal entry for a recorder that threw. Its own push is
 * guarded: if even this fails, the ACK still proceeds.
 * @param {object} state
 * @param {string} phase
 * @param {unknown} err
 */
function journalRecordFailure(state, phase, err) {
  const message = String(err && err.message ? err.message : err);
  try {
    pushJournal(state, {
      at: new Date().toISOString(), phase, recordFailed: true, error: message,
    });
  } catch {
    /* the journal itself is unusable; the ACK still matters more */
  }
  tick(state?.sessionId, {
    phase,
    type: 'recovery-record-failed',
    level: 'warn',
    message: `복구 판정 기록 실패 (${phase}) — 단계 확인은 그대로 진행됩니다`,
    data: { error: message },
  });
}

/**
 * Everything the judgement is made from, read once so the rest of the flow
 * touches no live state. Reading `state.crossCheck` can throw on an
 * accessor-backed state, which is why this runs inside the caller's try.
 * @param {object} state
 * @param {object} payload
 * @returns {{phase: string|null, status: string|null, fixedNext: string|null,
 *   rawToken: string|null, verdict: string|null, verification: string}}
 */
function readSignals(state, payload) {
  const raw = state?.crossCheck?.verdict;
  const rawToken = typeof raw === 'string' ? raw : null;
  return {
    phase: payload?.phase ?? null,
    status: payload?.status ?? null,
    fixedNext: payload?.fixedNext ?? null,
    rawToken,
    verdict: adaptVerdict(rawToken),
    verification: foldVerify(state?.verifyResult),
  };
}

/**
 * True when the phase simply succeeded: reported done, verification measured
 * PASS, and the reviewer either agreed or said nothing the adapter recognises.
 * @param {{status: string|null, verification: string, verdict: string|null}} s
 * @returns {boolean}
 */
function isCleanVerify(s) {
  return s.status === 'done'
    && s.verification === 'PASS'
    && (s.verdict === 'PASS' || s.verdict === null);
}

/**
 * Classify the failure and ask the controller for a recommendation. A reviewer
 * PASS reaches `classify()` as `null` — PASS is not verification evidence and
 * the classifier treats it as a precondition violation — while the raw token
 * survives on the journal row as `verdictRaw`, so nothing is lost.
 * @param {object} state
 * @param {object} signals - {@link readSignals} output.
 * @returns {{classification: object, decision: object, repairAttempts: number, seen: number}}
 */
function judge(state, signals) {
  const classification = classify({
    verdict: signals.verdict === 'PASS' ? null : signals.verdict,
    verification: { status: signals.verification },
    history: state?.recoveryJournal,
  });
  const counters = state?.counters ?? {};
  const repairAttempts = intOrZero(counters.buildFailures) + intOrZero(counters.testFailures);
  const seen = sameClassAttempts(state?.recoveryJournal, classification.class);
  const decision = decide(classification, {
    onFailure: VERIFY_ON_FAILURE,
    repairAttempts,
    replanAttempts: 0,
    sameClassAttempts: seen,
  });
  return {
    classification, decision, repairAttempts, seen,
  };
}

/** Row fields mirrored into the event — one list, so the two cannot drift. */
const TICK_FIELDS = Object.freeze([
  'class', 'action', 'target', 'verdict', 'verificationStatus', 'fixedNext', 'divergent',
]);

/**
 * Mirror the journal row into the session event stream. Advisory — `tick`
 * swallows its own failures.
 * @param {object} state
 * @param {object} row
 */
function emitDecisionTick(state, row) {
  tick(state?.sessionId, {
    phase: row.phase,
    type: 'recovery-decided',
    level: 'info',
    message: `복구 판정 기록: ${row.class} → ${row.action} (고정 전이 ${row.fixedNext ?? 'n/a'} 유지)`,
    data: Object.fromEntries(TICK_FIELDS.map((key) => [key, row[key]])),
  });
}

/**
 * Record a recovery judgement for a VERIFY result. Best-effort, and silent on
 * success: returns `null` and writes nothing when {@link isCleanVerify} holds.
 * Every other combination is recorded, `done` + `UNMEASURED` included, because
 * how often the engine cannot measure its own verification is the number this
 * Observe stage exists to produce.
 *
 * @param {object} state - Live session state. `recoveryJournal` is the only
 *   field mutated; `crossCheck`, `verifyResult`, `counters`, `sessionId` read.
 * @param {{phase?: string, status?: string, fixedNext?: string|null}} payload
 *   The `recordPhaseResult` payload. `fixedNext` is passed in rather than
 *   derived so this module never imports `engine-state.js`.
 * @returns {object|null} The appended row, or null when nothing was recorded.
 */
export function recordRecoveryDecision(state, payload = {}) {
  const phase = payload?.phase ?? null;
  try {
    const signals = readSignals(state, payload);
    // PASS is not a failure. Zero rows, zero telemetry lines.
    if (isCleanVerify(signals)) return null;

    const {
      classification, decision, repairAttempts, seen,
    } = judge(state, signals);

    const row = pushJournal(state, {
      at: new Date().toISOString(),
      phase: signals.phase,
      status: signals.status,
      verdictRaw: signals.rawToken,
      verdict: signals.verdict,
      verificationStatus: signals.verification,
      class: classification.class,
      classReason: classification.reason,
      action: decision.action,
      target: decision.target,
      reason: decision.reason,
      repairAttempts,
      sameClassAttempts: seen,
      fixedNext: signals.fixedNext,
      // Always true at the Observe stage: the fixed transition ignores the
      // recommendation. CA-03 is what makes `false` possible.
      divergent: true,
      recordedBy: 'recovery-record',
    });

    emitDecisionTick(state, row);
    return row;
  } catch (err) {
    journalRecordFailure(state, phase, err);
    return null;
  }
}
