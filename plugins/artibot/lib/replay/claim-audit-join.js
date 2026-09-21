/**
 * Claim audit ↔ spawn JOIN — the raw material of the "spawn key score".
 *
 * ONE EVENT, ONE WRITER, AN OPTIONAL KEY
 * ---------------------------------------------------------------------------
 * `lib/review/verdict-writer.js#buildClaimAuditEvent` is the only producer of
 * `review.claim_audit`. It writes the three counts 설계 §4.1 requires
 * (`subject_agent_type`, `claims_total`, `claims_refuted`) and adds
 * `subject_agent_id` ONLY when the reviewer's block carried one
 * (`verdict-writer.js#claimAuditData`). The allowlist types every optional key
 * as `string`, which is what makes "unknown" unrepresentable: a line that does
 * not know the subject's spawn id OMITS THE KEY rather than writing null
 * (`schemas/ledger-events.allowlist.json`, `review.claim_audit.subject_model`).
 * So an audit with no subject is a NORMAL line, not a broken one, and it is
 * counted apart from an audit whose subject simply found no bind — the first
 * could never be joined, the second could have been.
 *
 * `replay.js#PROJECTED_EVENTS` does not project this event (measured
 * 2026-09-21), so this fold filters the ledger rows itself instead of reading
 * another fold's projection.
 *
 * WHICH SPAWN IDS COUNT AS BOUND
 * ---------------------------------------------------------------------------
 * The default set is `route-bind.js#joinRouteBinds(events).bound[]` — bind
 * truth stays in ONE module rather than being re-derived here. That set is
 * NARROWER than the one `spawn-outcome.js#collect` builds, in two ways, and
 * neither module is wrong: `joinRouteBinds` drops a bind whose `tool_use_id`
 * OR `agent_id` is unusable and puts a bind whose `route.selected` receipt is
 * absent from the input in `orphan_binds`, so `bound[]` means "bound to a
 * receipt this read could see"; `spawn-outcome.js` keeps every `route.bound`
 * row with a usable `agent_id`, receipt or not, so its set means "the router
 * bound this spawn". An audit of a spawn whose receipt rotated out therefore
 * reads as unjoined here. The `agentIds` option exists for exactly that
 * disagreement: a caller that already holds the wider set passes it in rather
 * than this module growing a second opinion about what a bind is. An EMPTY
 * iterable is honoured as "no bound spawns" — it is not the same input as an
 * absent option.
 *
 * PURITY (design §1-8, L2). No clock, no filesystem, no randomness. The events
 * array is the injected port: the caller passes `lib/runtime/ledger.js`'s
 * `readAllEvents` output (deduplicated, file order), which this module may not
 * import (L2 to L5 is forbidden). `by_agent` is sorted, and every other field
 * is a count or a ratio of counts, so a shuffled input serializes to the same
 * bytes.
 *
 * ── WHAT THIS MODULE CANNOT SEE (repo rule §9: write it next to the gate) ────
 *  1. WHAT A `subject_agent_id` LOOKS LIKE. `review.claim_audit` was 0 rows on
 *     the central ledger at 2026-09-21T03:46Z, so there is NO sample of the
 *     value this join keys on. The join is therefore EXACT STRING EQUALITY with
 *     no normalization: no prefix strip, no case fold, no trim. Any such rule
 *     would be a guess that manufactures joins, and a manufactured join moves
 *     `pass_rate` — the one number this fold exists to produce. In particular
 *     `spawn-outcome.js#AGENT_RUN_PREFIX` ('agent-') is NOT applied: that is a
 *     `usage.receipt.run_id` spelling rule, not a `route.bound.agent_id` one
 *     (live bind ids look like `a4cda8fad92aab420` or `asplit-…-<hex>`). The
 *     day live rows exist, measure the value and revisit this decision here.
 *  2. WHETHER A REFUTED CLAIM WAS WRONGLY REFUTED. `pass_rate` is a ratio of
 *     two numbers a reviewer wrote about itself-adjacent work. 설계 §4.4 #2's
 *     counting rule (one citation = 1 claim, one number = 1 claim, one
 *     judgement sentence = 1 claim) is a rule for the WRITER of the review
 *     document; nothing in the line lets this fold check that it was followed.
 *     Two audits with the same `pass_rate` may have counted differently.
 *  3. WHETHER TWO AUDITS OF ONE AGENT ARE INDEPENDENT. They are SUMMED. A
 *     reviewer that re-emitted a corrected audit produces a second line rather
 *     than an overwrite (`verdict-writer.js#claimAuditIdempotencyKey` hashes the
 *     counts, so a changed count is a NEW key), and the corrected and the
 *     original are arithmetically indistinguishable here. The sum is then a
 *     double count, and which of the two rows is stale is not decidable from
 *     the rows.
 *  4. THE REVIEWED AGENT'S MODEL. `data.subject_model` is empty until the L2 D1
 *     route-receipt bind lands (allowlist `review.claim_audit.spec`: SubagentStart
 *     carries no model), so this fold cannot stratify by model — §4.1's
 *     stratification is model × nature × agent definition and only the last two
 *     are readable today. `nature` is deliberately NOT read either: an untagged
 *     report leaves the key absent and 설계 §4.4 #4 drops it from the
 *     denominator rather than guessing a stratum, so stratifying belongs in a
 *     fold that can say which rows it dropped.
 *  5. A MALFORMED ROW'S INTENT. `malformed_audits` counts rows whose counts are
 *     not integers or violate `0 <= claims_refuted <= claims_total`. The
 *     allowlist checks `Number.isInteger` and NOTHING else — the bound and the
 *     relation are enforced by `lib/review/independent-reviewer.js#parseClaimAudit`
 *     before a line is built, so a row that fails here was assembled by hand
 *     (allowlist `claims_total.description`). Whether it was a typo or a
 *     fabrication is not visible; it is in NO denominator either way.
 *  6. RETENTION AND WINDOWING. An audit whose bind falls outside the read
 *     window is indistinguishable here from an audit of a spawn that never
 *     bound, and both are indistinguishable from a bind line that was never
 *     written.
 *
 * @module lib/replay/claim-audit-join
 */

import { joinRouteBinds } from './route-bind.js';

/** The two ledger events this fold reads. */
export const CLAIM_AUDIT_JOIN_EVENTS = Object.freeze({
  bind: 'route.bound',
  audit: 'review.claim_audit',
});

/** Is `value` a non-empty string? @param {unknown} value @returns {boolean} */
function isStr(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Stable string order. @param {string} a @param {string} b @returns {number} */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `value` as a plain object, or an empty one. @param {unknown} value @returns {object} */
function obj(value) {
  return value && typeof value === 'object' ? value : {};
}

/**
 * The pass rate of one claim population, or null when it is empty.
 *
 * NEVER 0 on an empty denominator: a 0 reads as "every claim was refuted",
 * which is a finding, where the truth is that nothing was measured.
 *
 * @param {number} total - claims counted.
 * @param {number} refuted - claims overturned.
 * @returns {number|null} the rate, or null when `total` is 0.
 */
function rateOf(total, refuted) {
  return total === 0 ? null : (total - refuted) / total;
}

/**
 * The join terms of one `review.claim_audit` row.
 *
 * @param {object} e - screened ledger line.
 * @returns {{subject_agent_id: string|null, claims_total: number,
 *   claims_refuted: number}|null} the audit, or null when the counts are
 *   unusable (CANNOT SEE #5). A non-object `data` lands here too: it carries no
 *   readable count at all.
 */
function auditOf(e) {
  const d = obj(e.data);
  const total = d.claims_total;
  const refuted = d.claims_refuted;
  if (!Number.isInteger(total) || !Number.isInteger(refuted)) return null;
  if (refuted < 0 || refuted > total) return null;
  return {
    subject_agent_id: isStr(d.subject_agent_id) ? d.subject_agent_id : null,
    claims_total: total,
    claims_refuted: refuted,
  };
}

/**
 * The spawn ids an audit may join to.
 *
 * A supplied `agentIds` WINS, so a caller holding the wider bind set (see the
 * header) decides rather than this module. Anything that is not an iterable
 * object falls back to `joinRouteBinds`; non-string members are dropped, since
 * a join key that is not a string cannot equal a `subject_agent_id`.
 *
 * @param {object[]} list - ledger lines.
 * @param {unknown} opts - the caller's options bag.
 * @returns {Set<string>} bound agent ids.
 */
function agentIdSet(list, opts) {
  const supplied = obj(opts).agentIds;
  const out = new Set();
  if (supplied !== null && typeof supplied === 'object'
    && typeof supplied[Symbol.iterator] === 'function') {
    for (const id of supplied) if (isStr(id)) out.add(id);
    return out;
  }
  for (const b of joinRouteBinds(list).bound) if (isStr(b.agent_id)) out.add(b.agent_id);
  return out;
}

/**
 * Join `review.claim_audit` rows to the spawns `route.bound` bound.
 *
 * @param {object[]} events - ledger lines in file order; a non-array reads as
 *   an empty ledger.
 * @param {{agentIds?: Iterable<string>}} [opts] - bound agent ids to join
 *   against, instead of the ones derived from the input.
 * @returns {object} the claim-audit fold. `audits` counts the rows whose counts
 *   are readable and splits EXHAUSTIVELY into `joined + unjoined_audits +
 *   no_subject_audits`; `malformed_audits` is outside that split and in no
 *   denominator. `claims_total` and `claims_refuted` sum JOINED rows only — an
 *   unjoined audit's counts belong to no agent, and adding them to the total
 *   would price a population the `by_agent` breakdown cannot show. `pass_rate`
 *   is `null` — never 0 — when `claims_total` is 0, at the top level and per
 *   agent alike (an empty denominator is UNMEASURED, and the live ledger's
 *   current 0/0 has to be sayable without reading as a measurement). `by_agent`
 *   is ascending by `agent_id`, one row per agent, with that agent's N audits
 *   summed (CANNOT SEE #3).
 */
export function joinClaimAudits(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const agentIds = agentIdSet(list, opts);
  const totals = new Map();
  const counts = { audits: 0, malformed: 0, joined: 0, unjoined: 0, noSubject: 0 };
  let claimsTotal = 0;
  let claimsRefuted = 0;

  for (const e of list) {
    if (!e || typeof e !== 'object' || e.event !== CLAIM_AUDIT_JOIN_EVENTS.audit) continue;
    const a = auditOf(e);
    if (a === null) {
      counts.malformed += 1;
      continue;
    }
    counts.audits += 1;
    if (a.subject_agent_id === null) {
      counts.noSubject += 1;
      continue;
    }
    if (!agentIds.has(a.subject_agent_id)) {
      counts.unjoined += 1;
      continue;
    }
    counts.joined += 1;
    claimsTotal += a.claims_total;
    claimsRefuted += a.claims_refuted;
    const row = totals.get(a.subject_agent_id)
      ?? { audits: 0, claims_total: 0, claims_refuted: 0 };
    row.audits += 1;
    row.claims_total += a.claims_total;
    row.claims_refuted += a.claims_refuted;
    totals.set(a.subject_agent_id, row);
  }

  return {
    audits: counts.audits,
    malformed_audits: counts.malformed,
    joined: counts.joined,
    unjoined_audits: counts.unjoined,
    no_subject_audits: counts.noSubject,
    claims_total: claimsTotal,
    claims_refuted: claimsRefuted,
    pass_rate: rateOf(claimsTotal, claimsRefuted),
    // An ARRAY, not a record: `agent_id` is caller data, and a plain object
    // keyed by it would make a spawn literally named `__proto__` a prototype
    // write instead of a visible row.
    by_agent: [...totals.entries()]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([agent_id, r]) => ({
        agent_id,
        audits: r.audits,
        claims_total: r.claims_total,
        claims_refuted: r.claims_refuted,
        pass_rate: rateOf(r.claims_total, r.claims_refuted),
      })),
  };
}
