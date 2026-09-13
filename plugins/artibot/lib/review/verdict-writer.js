/**
 * Ledger writers for `review.completed` and `review.claim_audit`.
 *
 * ── Why this is a sibling module, not part of the contract module ───────────
 * `independent-reviewer.js` owns the CONTRACT: it builds the review request and
 * judges whether a returned verdict is admissible. This module owns what
 * happens to an answer that already passed that judgement. The two were one
 * file until `independent-reviewer.js` reached 1,540 lines, past the 800-line
 * guideline; splitting on the parse/record seam keeps each file about one
 * decision.
 *
 * The safety property that kept them together still holds, because it is
 * enforced by the ARGUMENT TYPE rather than by the file boundary: every builder
 * here refuses anything whose `ok` is not `true`, and the only way to obtain
 * such an object is `parseReviewVerdict` / `parseClaimAudit`. A caller cannot
 * reach a builder without going through a parse result, so "inadmissible ⇒ no
 * line" is still a single decision.
 *
 * ── Still no I/O ───────────────────────────────────────────────────────────
 * L2, like the module it imports. No filesystem, no clock, no randomness, no
 * network. L2 may not import `lib/runtime/` (L5), so the append and the
 * already-written-keys lookup arrive as PORTS: the ledger writer is the
 * caller's dependency, not this module's. The ports mirror
 * `lib/verification/verify-writer.js#recordVerification`, which solved the same
 * problem for `verify.completed` — and which moved out of
 * `unified-verifier.js` in the same commit this module was split out of, for
 * the same reason.
 *
 * ── An absent optional field OMITS ITS KEY ──────────────────────────────────
 * `subject_model`, `subject_agent_id`, `nature` and `evidence_refs` are
 * declared `type: string` / `enum_ref` / `array` in
 * `schemas/ledger-events.allowlist.json`, and
 * `lib/runtime/ledger-schema.js#matchesType` rejects null. A key present with
 * a placeholder is therefore either a rejected line or — worse — a value that
 * later aggregates as if it were a model. `'unknown'` is never written.
 *
 * ── What green tests here do NOT prove ─────────────────────────────────────
 *  1. That any reviewer agent emits either block. No production caller wires
 *     these functions yet.
 *  2. That `claims_total` was counted by the rule of 설계 §4.4 #2. A
 *     well-formed block with an invented denominator is accepted, exactly as in
 *     `parseClaimAudit`.
 *  3. That the line survived a REAL project root. Every test passes an explicit
 *     `ledgerPath`, which bypasses the git-common-dir rule in
 *     `event-writer.js#ledgerFilePath`.
 *
 * @module lib/review/verdict-writer
 */

import { createHash } from 'node:crypto';

import {
  isNonEmptyArray,
  isNonEmptyString,
  MISSION_ID_PATTERN,
  parseClaimAudit,
  parseReviewVerdict,
  stableStringify,
} from './independent-reviewer.js';

/** The verdict event these builders produce inputs for. */
export const REVIEW_COMPLETED_EVENT = 'review.completed';

/** The claim-audit event these builders produce inputs for. */
export const REVIEW_CLAIM_AUDIT_EVENT = 'review.claim_audit';

/**
 * The `source` this module writes for both events
 * (`schemas/ledger-events.allowlist.json`, read 2026-09-12: `review.completed`
 * allows `["reviewer"]` only, `review.claim_audit` allows
 * `["reviewer", "supervisor"]`). One constant, not two, because this module is
 * the reviewer path — a supervisor-written audit is a different caller and must
 * not inherit the wider value by accident.
 */
export const REVIEW_LEDGER_SOURCE = 'reviewer';

/**
 * The `mission_id` an envelope may carry, or null.
 *
 * A malformed id is OMITTED rather than sent: `event-writer.js` would refuse
 * the whole line as an invalid envelope, whereas an absent key lets
 * `sessionFallbackMissionId` supply a valid one. Dropping the caller's bad id
 * costs a grouping key; sending it costs the measurement.
 *
 * @param {unknown} missionId candidate id
 * @returns {string|null} the id when it matches {@link MISSION_ID_PATTERN}
 */
function envelopeMissionId(missionId) {
  return isNonEmptyString(missionId) && MISSION_ID_PATTERN.test(missionId)
    ? missionId
    : null;
}

/**
 * Idempotency key for one `review.completed` line.
 *
 * Mirrors `lib/economics/receipt-envelope.js#usageReceiptIdempotencyKey`
 * (`<event>:<session>:<identity…>`). `verification_id` IS the identity of a
 * verdict — design §3.4 §5.5 makes it the join key across `review.md`,
 * `outcome.md` and the ledger — so two calls carrying the same verification id
 * are the same verdict and must collapse to one line.
 *
 * @param {string} sessionId envelope `session_id`
 * @param {string} verificationId the verdict's `verification_id`
 * @returns {string} `review.completed:<session>:<verification_id>`
 */
export function reviewCompletedIdempotencyKey(sessionId, verificationId) {
  return `${REVIEW_COMPLETED_EVENT}:${sessionId}:${verificationId}`;
}

/**
 * Idempotency key for one `review.claim_audit` line.
 *
 * An audit block has no id of its own, so the identity is a digest of the
 * fields that make it the audit it is. Every field except `subject_model` is
 * hashed, so correcting a count is a NEW line rather than a silent overwrite.
 *
 * ── What excluding `subject_model` actually does ────────────────────────────
 * Not what an earlier version of this comment claimed. It does NOT protect a
 * before/after-bind pair from double-writing: `subject_model` can only reach
 * here from the reviewer's own block via `parseClaimAudit`, and
 * {@link buildClaimAuditEvent} has no argument through which a bind could
 * inject one, so this writer cannot produce those two lines in the first place.
 *
 * The real, measurable effect is a LOSS: if a reviewer re-emits the same audit
 * with `subject_model` now filled in, the richer line hashes identically and is
 * deduped away silently. That is accepted, because one audit is one measurement
 * and therefore one line — enriching it with the reviewed agent's model is the
 * job of the L2 D1 route-receipt bind (설계 §1.3), which joins on
 * `subject_agent_id`, not of a second reviewer emission. A re-emit that differs
 * only by a field the reviewer could not have known (SubagentStart carries no
 * model) is not new information. Do NOT add a `subjectModel` parameter to make
 * such a re-emit distinct; that would put the bind's job in the writer.
 * The dedupe is pinned by `tests/review/verdict-writer.test.js`
 * ("does NOT change when subject_model alone changes").
 *
 * @param {string} sessionId envelope `session_id`
 * @param {object} audit a {@link parseClaimAudit} result
 * @returns {string} `review.claim_audit:<session>:<subject_agent_type>:<12 hex>`
 */
export function claimAuditIdempotencyKey(sessionId, audit) {
  const a = audit && typeof audit === 'object' && !Array.isArray(audit) ? audit : {};
  const identity = stableStringify({
    claims_total: a.claims_total ?? null,
    claims_refuted: a.claims_refuted ?? null,
    nature: a.nature ?? null,
    subject_agent_type: a.subject_agent_type ?? null,
    subject_agent_id: a.subject_agent_id ?? null,
    evidence_refs: Array.isArray(a.evidence_refs) ? a.evidence_refs : [],
  });
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 12);
  return `${REVIEW_CLAIM_AUDIT_EVENT}:${sessionId}:${a.subject_agent_type ?? ''}:${digest}`;
}

/**
 * Build the ledger input for one `review.completed` line.
 *
 * Refuses on `parsed.ok !== true`. That is the whole point: a legacy token, an
 * ambiguous token and a schema-invalid document each produce NO line, so a
 * schema violation can never be read as a pass (design §3.4). `foldedVerdict`
 * is never consulted here — it is an observation, not a verdict.
 *
 * @param {object} [args] build inputs
 * @param {object} [args.parsed] a {@link parseReviewVerdict} result
 * @param {string} [args.sessionId] envelope `session_id`
 * @param {string} [args.missionId] envelope `mission_id`; omitted when malformed
 * @param {string} [args.model] envelope `model`; REQUIRED by the allowlist here
 * @param {string} [args.findingsRef] path of the findings document
 * @param {string} [args.reviewerId] envelope `worker`; omitted when absent
 * @returns {{ok: true, input: object}|{ok: false, reason: string}} build outcome
 */
export function buildReviewCompletedEvent(args = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const { parsed, sessionId, missionId, model, findingsRef, reviewerId } = a;
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) {
    return { ok: false, reason: 'verdict-not-admissible' };
  }
  if (!isNonEmptyString(parsed.verificationId)) {
    return { ok: false, reason: 'missing:verification_id' };
  }
  if (!isNonEmptyString(sessionId)) return { ok: false, reason: 'missing:sessionId' };
  if (!isNonEmptyString(model)) return { ok: false, reason: 'missing:model' };
  if (!isNonEmptyString(findingsRef)) return { ok: false, reason: 'missing:findingsRef' };
  const mission = envelopeMissionId(missionId);
  return {
    ok: true,
    input: {
      event: REVIEW_COMPLETED_EVENT,
      session_id: sessionId,
      ...(mission === null ? {} : { mission_id: mission }),
      source: REVIEW_LEDGER_SOURCE,
      model,
      ...(isNonEmptyString(reviewerId) ? { worker: reviewerId } : {}),
      idempotency_key: reviewCompletedIdempotencyKey(sessionId, parsed.verificationId),
      data: {
        verdict: parsed.verdict,
        findings_ref: findingsRef,
        verification_id: parsed.verificationId,
      },
    },
  };
}

/**
 * The `data` object of a `review.claim_audit` line.
 *
 * Split out of {@link buildClaimAuditEvent} because "which keys exist" is the
 * single decision this event is most likely to get wrong, and it deserves to be
 * readable on its own. Only the three required keys are unconditional.
 *
 * @param {object} parsed a {@link parseClaimAudit} result with `ok:true`
 * @returns {object} the event `data`, carrying no null-valued optional key
 */
function claimAuditData(parsed) {
  const data = {
    subject_agent_type: parsed.subject_agent_type,
    claims_total: parsed.claims_total,
    claims_refuted: parsed.claims_refuted,
  };
  if (isNonEmptyString(parsed.nature)) data.nature = parsed.nature;
  if (isNonEmptyString(parsed.subject_model)) data.subject_model = parsed.subject_model;
  if (isNonEmptyString(parsed.subject_agent_id)) {
    data.subject_agent_id = parsed.subject_agent_id;
  }
  if (isNonEmptyArray(parsed.evidence_refs)) data.evidence_refs = parsed.evidence_refs;
  return data;
}

/**
 * Build the ledger input for one `review.claim_audit` line.
 *
 * The envelope `model` is OPTIONAL here, unlike `review.completed`: the
 * allowlist lists no `required_envelope` for this event, and the model that
 * matters to §4.1 is the REVIEWED agent's (`data.subject_model`), not the
 * reviewer's. Requiring the reviewer's tier would refuse rows the Observe phase
 * can actually produce.
 *
 * @param {object} [args] build inputs
 * @param {object} [args.parsed] a {@link parseClaimAudit} result
 * @param {string} [args.sessionId] envelope `session_id`
 * @param {string} [args.missionId] envelope `mission_id`; omitted when malformed
 * @param {string} [args.model] envelope `model`; omitted when absent
 * @param {string} [args.reviewerId] envelope `worker`; omitted when absent
 * @returns {{ok: true, input: object}|{ok: false, reason: string}} build outcome
 */
export function buildClaimAuditEvent(args = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const { parsed, sessionId, missionId, model, reviewerId } = a;
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) {
    return { ok: false, reason: 'claim-audit-not-admissible' };
  }
  if (!isNonEmptyString(sessionId)) return { ok: false, reason: 'missing:sessionId' };
  const mission = envelopeMissionId(missionId);
  return {
    ok: true,
    input: {
      event: REVIEW_CLAIM_AUDIT_EVENT,
      session_id: sessionId,
      ...(mission === null ? {} : { mission_id: mission }),
      source: REVIEW_LEDGER_SOURCE,
      ...(isNonEmptyString(model) ? { model } : {}),
      ...(isNonEmptyString(reviewerId) ? { worker: reviewerId } : {}),
      idempotency_key: claimAuditIdempotencyKey(sessionId, parsed),
      data: claimAuditData(parsed),
    },
  };
}

/**
 * Read the keys already in the ledger through the optional port.
 *
 * A port that THROWS yields `keys: null`, which makes every line `rejected`.
 * That is stricter than `scripts/hooks/session-end.js#existingReceiptKeys`,
 * which swallows the throw and appends anyway: a duplicated `review.completed`
 * inflates §4.1's denominator into a false measurement, while a line that was
 * not written is a visible absence. An ABSENT port is a different thing — "no
 * keys known" — and is not an error.
 *
 * @param {unknown} port `existingKeys` port
 * @returns {{keys: Set<string>|null, reason: string}} keys, or null with a reason
 */
function readExistingReviewKeys(port) {
  if (port === undefined || port === null) return { keys: new Set(), reason: '' };
  if (typeof port !== 'function') return { keys: null, reason: 'port-missing:existingKeys' };
  let raw;
  try {
    raw = port();
  } catch {
    return { keys: null, reason: 'port-threw:existingKeys' };
  }
  if (raw === undefined || raw === null) return { keys: new Set(), reason: '' };
  const keys = new Set();
  try {
    for (const k of /** @type {Iterable<unknown>} */ (raw)) {
      if (typeof k === 'string' && k.length > 0) keys.add(k);
    }
  } catch {
    // A non-iterable is a wiring defect, and reading "no duplicates" out of it
    // would be exactly the double-count this function exists to prevent.
    return { keys: null, reason: 'port-threw:existingKeys' };
  }
  return { keys, reason: '' };
}

/**
 * Append one built input through the port, and say what happened to it.
 *
 * @param {unknown} append `append` port
 * @param {object} input a `build*Event` result's `input`
 * @returns {{status: 'appended'|'rejected', reason?: string}} outcome
 */
function appendReviewLine(append, input) {
  if (typeof append !== 'function') {
    return { status: 'rejected', reason: 'port-missing:append' };
  }
  let res;
  try {
    res = append(input);
  } catch {
    return { status: 'rejected', reason: 'port-threw:append' };
  }
  if (res && typeof res === 'object' && res.ok === true) return { status: 'appended' };
  const reason = res && typeof res === 'object' ? res.reason : null;
  return {
    status: 'rejected',
    reason: isNonEmptyString(reason) ? reason : 'append-failed',
  };
}

/**
 * Dedupe-then-append one built line.
 *
 * `skipped` and `rejected` are kept apart on purpose: `skipped` means no line
 * was ever built (the answer was not admissible, or a required argument was
 * missing), `rejected` means a line existed and the ledger refused it. Folding
 * them into one status would make an inadmissible verdict look like a write
 * failure, and a write failure look like a reviewer who said nothing.
 *
 * @param {{ok: boolean, input?: object, reason?: string}} built a builder result
 * @param {{keys: Set<string>|null, reason: string}} seen {@link readExistingReviewKeys}
 * @param {unknown} append `append` port
 * @returns {{status: string, key?: string, reason?: string}} per-line outcome
 */
function recordReviewLine(built, seen, append) {
  if (built.ok !== true) return { status: 'skipped', reason: built.reason };
  const key = built.input.idempotency_key;
  if (seen.keys === null) return { status: 'rejected', key, reason: seen.reason };
  if (seen.keys.has(key)) return { status: 'deduped', key };
  const outcome = appendReviewLine(append, built.input);
  if (outcome.status === 'appended') {
    // Added to the local set as well as the ledger, so two lines built in one
    // call cannot collide with each other before the port is re-read.
    seen.keys.add(key);
    return { status: 'appended', key };
  }
  return { status: 'rejected', key, reason: outcome.reason };
}

/**
 * Record a reviewer's answer as up to two ledger lines through injected ports.
 *
 * NEVER THROWS. A throwing port becomes a `rejected` line carrying
 * `port-threw:<name>`; garbage arguments become two `skipped` lines. This runs
 * in hook-shaped contexts, where an exception out of here would take down the
 * caller and make the whole review look like it never happened.
 *
 * The two halves are INDEPENDENT. A legacy verdict beside a well-formed audit
 * block writes the audit and nothing else, because the audit is a real
 * measurement of a real report and refusing it would lose data that was
 * correctly counted.
 *
 * @param {object} [args] recording inputs
 * @param {string|object} [args.verdictText] the reviewer's whole answer
 * @param {string} [args.sessionId] envelope `session_id`
 * @param {string} [args.missionId] envelope `mission_id`
 * @param {string} [args.model] envelope `model` (the REVIEWER's model)
 * @param {string} [args.findingsRef] path of the findings document
 * @param {string} [args.reviewerId] envelope `worker`
 * @param {Function} [args.validateSchema] optional validator port, forwarded to
 *   {@link parseReviewVerdict}
 * @param {object} [ports] I/O ports
 * @param {(input: object) => object} [ports.append] `appendLedgerEvent` bound
 *   to a project root
 * @param {() => Iterable<string>} [ports.existingKeys] idempotency keys already
 *   in the ledger for this session
 * @returns {{review: {status: string, key?: string, reason?: string},
 *   claimAudit: {status: string, key?: string, reason?: string},
 *   parsed: {verdict: object, claimAudit: object}}} what happened to each half
 */
export function recordReviewOutcome(args, ports) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const opts = typeof a.validateSchema === 'function'
    ? { validateSchema: a.validateSchema }
    : {};
  const parsed = {
    verdict: parseReviewVerdict(a.verdictText, opts),
    claimAudit: parseClaimAudit(a.verdictText),
  };
  const review = buildReviewCompletedEvent({
    parsed: parsed.verdict,
    sessionId: a.sessionId,
    missionId: a.missionId,
    model: a.model,
    findingsRef: a.findingsRef,
    reviewerId: a.reviewerId,
  });
  const claimAudit = buildClaimAuditEvent({
    parsed: parsed.claimAudit,
    sessionId: a.sessionId,
    missionId: a.missionId,
    model: a.model,
    reviewerId: a.reviewerId,
  });
  if (review.ok !== true && claimAudit.ok !== true) {
    // Nothing was built, so no port is touched: an unreadable answer must not
    // cost a ledger read, and it must not be able to fail for a port's reason.
    return {
      review: { status: 'skipped', reason: review.reason },
      claimAudit: { status: 'skipped', reason: claimAudit.reason },
      parsed,
    };
  }
  const p = ports && typeof ports === 'object' && !Array.isArray(ports) ? ports : {};
  const seen = readExistingReviewKeys(p.existingKeys);
  return {
    review: recordReviewLine(review, seen, p.append),
    claimAudit: recordReviewLine(claimAudit, seen, p.append),
    parsed,
  };
}
