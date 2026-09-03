/**
 * Failure classifier — names the KIND of a failure and nothing else.
 *
 * Observe stage (design §2.5): this module records a judgement. It does not
 * act on it. `lib/autopilot/engine.js` is not touched by this work — the
 * `nextPhase: 'IMPROVE'` transition at engine.js:497 stays fixed until the
 * Canary stage. Wiring a consumer is a later task, deliberately.
 *
 * ── Where the five classes come from ──────────────────────────────────────
 * ADDENDUM-HARDENING §35 states the recovery ladder in terms of *failure
 * class*, not retry count:
 *
 *     implementation failure                        -> repair
 *     repeated same-class failure                   -> replan
 *     multiple replans / architecture contradiction -> ultraplan
 *     ultraplan still ambiguous                     -> human decision
 *
 * Lane 4 §1.6 names the four classes behind those rungs (구현결함 / Plan 결함 /
 * 프레이밍 / 가치결정). `unknown` is the fifth, and it is not a filler value:
 * a classifier that cannot separate the evidence must say so rather than
 * guess, and the controller sends `unknown` to a person. Guessing here is the
 * fail-open shape this repo has been bitten by before.
 *
 * ── Division of labour with recovery-controller ───────────────────────────
 * This module answers "what kind of failure is this, given the evidence in
 * front of me". Every *threshold* — how many repairs before replanning, how
 * many replans before proposing an ultraplan — belongs to
 * `recovery-controller.js#decide`. Two modules owning one threshold is how
 * thresholds drift, so the counting rungs of §35 live in exactly one file and
 * this one is not it. `history` is accepted (lane 4 §2.3 puts it in the
 * signature) but only populates `signals.priorSameClass`; it never moves the
 * class.
 *
 * ── Verdict vocabulary ────────────────────────────────────────────────────
 * `verdict` is one of the five canonical values of
 * `schemas/review-output.schema.json#/definitions/reviewOutputV2` (Hardening
 * §15), re-exported here from `lib/review/independent-reviewer.js` so the list
 * exists once. The four legacy vocabularies reach those five only through
 * `schemas/verdict-adapter-map.json`; folding them is the job of that adapter,
 * not of this module. In particular `SPEC_FAIL` is the one row that splits
 * (REPAIR_REQUIRED vs INTENT_REVIEW_REQUIRED) and the adapter is required to
 * return `ambiguous:true` rather than pick — so an ambiguous token never
 * arrives here as a verdict at all.
 *
 * @module lib/recovery/failure-classifier
 */

/**
 * The five failure classes. `unknown` is a first-class answer, not an error
 * code: it means "the evidence does not separate the other four", and the
 * controller routes it to a human.
 * @type {readonly string[]}
 */
export const FAILURE_CLASSES = Object.freeze([
  'implementation',
  'plan',
  'framing',
  'human-value',
  'unknown',
]);

/**
 * Canonical review verdicts, re-exported from the module that owns the
 * vocabulary rather than copied. `lib/review` and `lib/recovery` are both L2,
 * so the sibling import is legal, and it is the honest edge: this classifier's
 * entire input contract is a verdict that the reviewer produced.
 *
 * An earlier revision declared its own copy and pinned it to
 * `schemas/review-output.schema.json` with a drift test. That works, but three
 * copies of one enum held together by three separate tests is a worse shape
 * than one exported constant — the test only tells you they diverged after
 * someone has already written the second truth.
 */
export { CANONICAL_VERDICTS } from '../review/independent-reviewer.js';

/**
 * Verdict -> class, as an allowlist. Entries absent from this table fall
 * through to `unknown` on purpose: a deny-list would fail open for every
 * verdict added later.
 *
 * `PASS` is deliberately NOT a key. PASS is not a failure, so classifying it
 * is a caller precondition violation, and the fail-closed answer to a
 * precondition violation is `unknown` (-> a human looks), never a silent
 * "nothing to do".
 *
 * `BLOCK` and `INTENT_REVIEW_REQUIRED` both land on `human-value`, for
 * different reasons recorded in the returned `reason`: BLOCK is a reviewer
 * refusing the change outright, INTENT_REVIEW_REQUIRED is the requirement
 * itself being contradictory or unclear (verdict-adapter-map.json, SPEC_FAIL
 * row). Neither is repairable by machine.
 */
const VERDICT_TO_CLASS = Object.freeze({
  REPAIR_REQUIRED: 'implementation',
  REPLAN_REQUIRED: 'plan',
  INTENT_REVIEW_REQUIRED: 'human-value',
  BLOCK: 'human-value',
});

const VERDICT_REASON = Object.freeze({
  REPAIR_REQUIRED:
    'Reviewer asked for a repair: the implementation falls short of a plan that still stands (Hardening §35 rung 1).',
  REPLAN_REQUIRED:
    'Reviewer asked for a replan: the defect is in the plan, not in the code written against it.',
  INTENT_REVIEW_REQUIRED:
    'Reviewer sent the requirement itself back. What the user wants is a value decision, so no machine rung applies (verdict-adapter-map.json, SPEC_FAIL row).',
  BLOCK:
    'Reviewer issued BLOCK. That is a refusal, not a remediation request, and it is not mechanically repairable.',
});

/** Verification fold statuses, `unified-verifier` (design §3.4). */
const VERIFICATION_STATUSES = Object.freeze(['PASS', 'FAIL', 'UNMEASURED']);

function normalizeVerdict(verdict) {
  if (typeof verdict !== 'string') return null;
  const trimmed = verdict.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeVerificationStatus(verification) {
  if (verification === null || typeof verification !== 'object') return null;
  const status = verification.status;
  return VERIFICATION_STATUSES.includes(status) ? status : null;
}

function normalizeContradictions(planDelta) {
  if (planDelta === null || typeof planDelta !== 'object') return Object.freeze([]);
  const raw = planDelta.contradictions;
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(raw.filter((entry) => typeof entry === 'string' && entry.trim() !== ''));
}

function countPriorSameClass(history, failureClass) {
  if (!Array.isArray(history)) return 0;
  let count = 0;
  for (const entry of history) {
    if (entry === null || typeof entry !== 'object') continue;
    const seen = typeof entry.class === 'string' ? entry.class : entry.classification;
    if (seen === failureClass) count += 1;
  }
  return count;
}

/**
 * Classify one failure.
 *
 * Precedence, highest first:
 *
 *  1. A canonical verdict in {@link VERDICT_TO_CLASS} decides the class. The
 *     reviewer looked at the change; this module did not.
 *  2. An architecture contradiction (`planDelta.contradictions` non-empty)
 *     upgrades `plan` to `framing`, and ONLY `plan`. §35 stacks the
 *     contradiction rung directly above the plan rung, so the upgrade is one
 *     step. It deliberately does not upgrade `implementation`: letting an
 *     under-specified input field override an explicit REPAIR_REQUIRED would
 *     be this module deciding it knows better than the reviewer, which it does
 *     not.
 *  3. With no verdict, a `verification.status` of FAIL is the textbook
 *     implementation failure of §35 rung 1 — a red build or test with no
 *     reviewer opinion attached.
 *  4. Everything else, `UNMEASURED` included, is `unknown`. Calling an
 *     unmeasured layer a pass is the exact error that `unified-verifier` makes
 *     UNMEASURED a first-class status to prevent (design §3.4).
 *
 * Note on reachability, mirroring `verdict-adapter-map.json#unreachable_verdicts`:
 * `framing` requires REPLAN_REQUIRED, and no reviewer in the repo emits that
 * token today. So `framing` is reachable by contract and unreachable in
 * practice until the v2 vocabulary is actually emitted. The other route to an
 * ultraplan in the controller (repeated replans) does not depend on this class.
 *
 * @param {object} [input]
 * @param {string} [input.verdict] Canonical review verdict, one of
 *   {@link CANONICAL_VERDICTS}. Absent when no review ran.
 * @param {{status?: string}} [input.verification] `unified-verifier` fold.
 * @param {{contradictions?: string[]}} [input.planDelta] Evidence that the plan
 *   itself moved or is self-contradictory. The shape is provisional: no
 *   producer exists yet, so only `contradictions` is read and everything else
 *   is ignored rather than guessed at.
 * @param {Array<{class?: string}>} [input.history] Prior attempts. Advisory
 *   only — see the module note on the split with recovery-controller.
 * @returns {{class: string, verdictSeen: string|null, reason: string,
 *   signals: {priorSameClass: number, verificationStatus: string|null,
 *   contradictions: readonly string[]}}}
 */
export function classify(input = {}) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const verdict = normalizeVerdict(source.verdict);
  const verificationStatus = normalizeVerificationStatus(source.verification);
  const contradictions = normalizeContradictions(source.planDelta);

  let failureClass = 'unknown';
  let reason;

  if (verdict !== null && Object.hasOwn(VERDICT_TO_CLASS, verdict)) {
    failureClass = VERDICT_TO_CLASS[verdict];
    reason = VERDICT_REASON[verdict];
    if (failureClass === 'plan' && contradictions.length > 0) {
      failureClass = 'framing';
      reason =
        `Plan-level defect reported alongside ${contradictions.length} architecture contradiction(s), which sits one rung above a plan revision (Hardening §35). Framing is a proposal only; it never auto-fires an ultraplan.`;
    }
  } else if (verdict === 'PASS') {
    reason =
      'PASS is not a failure. classify() was called outside its precondition, and the fail-closed answer to that is unknown rather than a silent no-op.';
  } else if (verdict !== null) {
    reason =
      `Verdict ${JSON.stringify(verdict)} is not one of the five canonical values, so it is not folded to a class here. Legacy vocabularies must pass through schemas/verdict-adapter-map.json first.`;
  } else if (verificationStatus === 'FAIL') {
    failureClass = 'implementation';
    reason =
      'No review verdict, and verification folded to FAIL. A red build or test with no reviewer opinion is the implementation failure of Hardening §35 rung 1.';
  } else if (verificationStatus === 'UNMEASURED') {
    reason =
      'Verification is UNMEASURED. An unmeasured layer is not a pass and not a known failure, so it goes to a person rather than being named (design §3.4, UNMEASURED as a first-class status).';
  } else {
    reason =
      'No canonical verdict and no verification result. There is nothing to classify from, and an unclassifiable failure is escalated rather than guessed.';
  }

  return Object.freeze({
    class: failureClass,
    verdictSeen: verdict,
    reason,
    signals: Object.freeze({
      priorSameClass: countPriorSameClass(source.history, failureClass),
      verificationStatus,
      contradictions,
    }),
  });
}
