/**
 * Unit contract for the claim-audit join (`lib/replay/claim-audit-join.js`).
 *
 * The fold joins `review.claim_audit` rows (written by
 * `lib/review/verdict-writer.js#buildClaimAuditEvent`, the event's only
 * producer) to the spawn ids the router bound (`route.bound`), on the audit's
 * OPTIONAL `data.subject_agent_id` against the bind's `data.agent_id`, and sums
 * the §4.1 claim counts per agent.
 *
 * -- WHAT THIS SUITE CANNOT SEE (repo rules section 9) ----------------------
 *   - ZERO LIVE LINES. `review.claim_audit` was 0 rows on the central ledger at
 *     2026-09-21T03:46Z, so every row below is hand-built from the WRITER
 *     (`buildClaimAuditEvent`, `claimAuditData`) rather than measured. Nothing
 *     here says what a live `subject_agent_id` looks like, and therefore nothing
 *     here can justify a normalization rule; the exact-match test pins the
 *     absence of one, not its correctness.
 *   - THE WRITERS. That a Phase 4.5 reviewer emits an audit block at all, and
 *     that `subagent-handler.js#bindRoute` fires on every spawn, is those
 *     suites' business. This suite pins arithmetic over a given array.
 *   - FIXTURE SCALE. 3 binds and 6 audit rows. Live was 306 bind rows and 0
 *     audits at the measurement, so nothing here says anything about the fold
 *     at ledger size or about read cost.
 *   - WHETHER A REFUTED CLAIM IS A BAD ONE. `pass_rate` is a ratio of two
 *     counts the reviewer wrote. The fold counts; it does not judge, and
 *     neither does this suite.
 *   - WHETHER THE BOUND SET IS THE RIGHT SET. The default agent-id set comes
 *     from `joinRouteBinds().bound[]`, which requires the bind's `route.selected`
 *     receipt to be in the same input. A bind whose receipt rotated out is an
 *     orphan and its audits read as unjoined. This suite PINS that behaviour
 *     (see "an orphan bind is not in the default set"); it does not claim the
 *     choice is right.
 *
 * @module tests/replay/claim-audit-join
 */

import { describe, expect, it } from 'vitest';
import {
  CLAIM_AUDIT_JOIN_EVENTS,
  joinClaimAudits,
} from '../../lib/replay/index.js';

const MISSION = 'M-20260921-001';
const SESS_A = 'sess-a';
const AG1 = 'a4cda8fad92aab420';
const AG2 = 'asplit-claim-audit-9f31b7c';
const AG3 = 'a0011223344556677';

let seqCounter = 0;

/**
 * A `route.selected` PreToolUse receipt, as `route-observe-pre.js` writes it.
 *
 * Required because the default agent-id set is `joinRouteBinds().bound[]`, and
 * a bind with no receipt in the input is an orphan rather than a bound pair
 * (`route-bind.js#joinRouteBinds`).
 *
 * @param {string} toolUseId - the host's tool use id.
 * @param {string} [session] - envelope `session_id`.
 * @returns {object} ledger line.
 */
function selected(toolUseId, session = SESS_A) {
  seqCounter += 1;
  return {
    v: 1,
    ts: '2026-09-21T01:00:00.000Z',
    event: 'route.selected',
    session_id: session,
    source: 'hook',
    pid: 4242,
    seq: seqCounter,
    mission_id: MISSION,
    routing_epoch_id: toolUseId,
    data: { shadow_of: `tool_use:${toolUseId}`, stage: 'pre', action: { type: 'implement' } },
  };
}

/**
 * A `route.bound` row in the live envelope key order
 * (`subagent-handler.js#bindRoute`: `routing_epoch_id` = `run_id` = `agent_id`,
 * `action_id` = `tool_use_id`).
 *
 * @param {string} agentId - the spawned agent id.
 * @param {string} [session] - envelope `session_id`.
 * @returns {object} ledger line.
 */
function bound(agentId, session = SESS_A) {
  seqCounter += 1;
  const toolUseId = `toolu_${agentId}`;
  return {
    v: 1,
    ts: '2026-09-21T01:00:01.000Z',
    event: 'route.bound',
    session_id: session,
    source: 'hook',
    pid: 4242,
    seq: seqCounter,
    mission_id: MISSION,
    routing_epoch_id: agentId,
    run_id: agentId,
    action_id: toolUseId,
    data: {
      tool_use_id: toolUseId,
      agent_id: agentId,
      confidence: 'exact',
      method: 'prompt_id+name',
      matched_on: 'name',
      recommended_model: 'claude-opus-5',
      action_class: 'implement',
    },
  };
}

/** A bind and the receipt it bound, the pair `bound[]` needs. */
function spawn(agentId, session = SESS_A) {
  return [selected(`toolu_${agentId}`, session), bound(agentId, session)];
}

/**
 * A `review.claim_audit` row in the shape `buildClaimAuditEvent` produces.
 *
 * Optional keys are OMITTED, never null: `claimAuditData` only writes
 * `subject_agent_id`, `subject_model`, `nature` and `evidence_refs` when the
 * parsed block carries them, and the allowlist types them as `string`, so null
 * is not representable.
 *
 * @param {object} spec - subject, counts and the optional columns.
 * @returns {object} ledger line.
 */
function audit(spec) {
  const {
    subjectId, total, refuted, agentType = 'tdd-guide', nature, session = SESS_A, data,
  } = spec;
  seqCounter += 1;
  const envelope = {
    v: 1,
    ts: '2026-09-21T02:00:00.000Z',
    event: 'review.claim_audit',
    session_id: session,
    source: 'reviewer',
    pid: 4242,
    seq: seqCounter,
    mission_id: MISSION,
    worker: 'code-reviewer',
    idempotency_key: `review.claim_audit:${session}:${agentType}:${seqCounter}`,
  };
  if (data !== undefined) return { ...envelope, data };
  return {
    ...envelope,
    data: {
      subject_agent_type: agentType,
      claims_total: total,
      claims_refuted: refuted,
      ...(nature === undefined ? {} : { nature }),
      ...(subjectId === undefined ? {} : { subject_agent_id: subjectId }),
    },
  };
}

/**
 * Three bound spawns, three joined audits, two unjoined and one with no
 * subject: `audits` 6, `joined` 3, `unjoined_audits` 2, `no_subject_audits` 1.
 *
 * The unjoined rows carry deliberately huge counts (100/100) so a sum that
 * leaks them into the totals is visible rather than plausible.
 *
 * @returns {object[]} ledger lines in file order.
 */
function fixture() {
  return [
    ...spawn(AG1),
    ...spawn(AG2),
    ...spawn(AG3),
    audit({ subjectId: AG1, total: 10, refuted: 2, nature: 'process' }),
    audit({ subjectId: AG2, total: 5, refuted: 0 }),
    audit({ subjectId: AG3, total: 5, refuted: 3 }),
    audit({ subjectId: 'a-never-bound-1', total: 100, refuted: 100 }),
    audit({ subjectId: 'a-never-bound-2', total: 100, refuted: 100 }),
    audit({ total: 100, refuted: 100 }),
  ];
}

/** Deterministic shuffle (same construction as `tests/replay/spawn-outcome.test.js`). */
function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 7919) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A second, differently seeded permutation. */
function reversedShuffle(arr) {
  return shuffled([...arr].reverse());
}

describe('joinClaimAudits() counts the join population', () => {
  it('splits audits into joined, unjoined and no-subject', () => {
    const f = joinClaimAudits(fixture());
    expect(f.audits).toBe(6);
    expect(f.joined).toBe(3);
    expect(f.unjoined_audits).toBe(2);
    expect(f.no_subject_audits).toBe(1);
    expect(f.malformed_audits).toBe(0);
  });

  it('holds the invariant audits === joined + unjoined + no_subject', () => {
    const f = joinClaimAudits(fixture());
    expect(f.audits).toBe(f.joined + f.unjoined_audits + f.no_subject_audits);
  });

  it('sums claims over JOINED rows only', () => {
    const f = joinClaimAudits(fixture());
    // 10 + 5 + 5 = 20; the unjoined 100/100 rows are in no sum.
    expect(f.claims_total).toBe(20);
    expect(f.claims_refuted).toBe(5);
    expect(f.pass_rate).toBe(0.75);
  });

  it('breaks the sums down per agent, in agent_id order', () => {
    const f = joinClaimAudits(fixture());
    // Sorted: 'a0011...' < 'a4cda...' < 'asplit-...' (digits before letters).
    expect(f.by_agent).toEqual([
      { agent_id: AG3, audits: 1, claims_total: 5, claims_refuted: 3, pass_rate: 0.4 },
      { agent_id: AG1, audits: 1, claims_total: 10, claims_refuted: 2, pass_rate: 0.8 },
      { agent_id: AG2, audits: 1, claims_total: 5, claims_refuted: 0, pass_rate: 1 },
    ]);
    expect(f.by_agent.map((r) => r.agent_id)).toEqual([...f.by_agent.map((r) => r.agent_id)].sort());
  });

  it('adds up N audits of the SAME agent into one row', () => {
    const rows = [
      ...spawn(AG1),
      audit({ subjectId: AG1, total: 4, refuted: 1 }),
      audit({ subjectId: AG1, total: 6, refuted: 2, nature: 'process' }),
    ];
    const f = joinClaimAudits(rows);
    expect(f.joined).toBe(2);
    expect(f.by_agent).toEqual([
      { agent_id: AG1, audits: 2, claims_total: 10, claims_refuted: 3, pass_rate: 0.7 },
    ]);
  });
});

describe('joinClaimAudits() reports an unmeasured rate as null', () => {
  it('returns all-zero counts and a null rate for an empty ledger', () => {
    // The live state at 2026-09-21T03:46Z is 0 audit rows, and this is the
    // answer that must be sayable out loud without reading as a measurement.
    const f = joinClaimAudits([]);
    expect(f).toEqual({
      audits: 0,
      malformed_audits: 0,
      joined: 0,
      unjoined_audits: 0,
      no_subject_audits: 0,
      claims_total: 0,
      claims_refuted: 0,
      pass_rate: null,
      by_agent: [],
    });
  });

  it('reads a non-array input as an empty ledger', () => {
    const empty = JSON.stringify(joinClaimAudits([]));
    for (const bad of [undefined, null, 0, 'rows', {}, { length: 3 }]) {
      expect(JSON.stringify(joinClaimAudits(bad))).toBe(empty);
    }
  });

  it('nulls pass_rate when the joined denominator is 0, never 0', () => {
    // A 0 would read as "every claim was refuted", which is a finding.
    const rows = [...spawn(AG1), audit({ subjectId: AG1, total: 0, refuted: 0 })];
    const f = joinClaimAudits(rows);
    expect(f.joined).toBe(1);
    expect(f.claims_total).toBe(0);
    expect(f.pass_rate).toBeNull();
    expect(f.by_agent).toEqual([
      { agent_id: AG1, audits: 1, claims_total: 0, claims_refuted: 0, pass_rate: null },
    ]);
  });

  it('skips a malformed row from EVERY denominator', () => {
    // The allowlist enforces `integer` and nothing else -- not the >= 0 bound
    // and not refuted <= total (allowlist `review.claim_audit.claims_total`
    // description) -- so a hand-assembled line can carry any of these.
    const rows = [
      ...spawn(AG1),
      audit({ subjectId: AG1, total: '10', refuted: 2 }),
      audit({ subjectId: AG1, total: 10.5, refuted: 2 }),
      audit({ subjectId: AG1, total: 10, refuted: -1 }),
      audit({ subjectId: AG1, total: 2, refuted: 3 }),
      audit({ subjectId: AG1, total: -1, refuted: -1 }),
      audit({ subjectId: AG1, data: 'not-an-object' }),
      audit({ subjectId: AG1, data: ['claims_total', 1] }),
      audit({ subjectId: AG1, total: 4, refuted: 1 }),
    ];
    const f = joinClaimAudits(rows);
    expect(f.malformed_audits).toBe(7);
    expect(f.audits).toBe(1);
    expect(f.joined).toBe(1);
    expect(f.unjoined_audits).toBe(0);
    expect(f.no_subject_audits).toBe(0);
    expect(f.claims_total).toBe(4);
    expect(f.pass_rate).toBe(0.75);
  });

  it('treats an empty-string subject id as no subject, not as a join attempt', () => {
    const f = joinClaimAudits([...spawn(AG1), audit({ subjectId: '', total: 3, refuted: 0 })]);
    expect(f.no_subject_audits).toBe(1);
    expect(f.unjoined_audits).toBe(0);
    expect(f.claims_total).toBe(0);
  });
});

describe('joinClaimAudits() joins on the exact string only', () => {
  it('does not normalize a prefix away', () => {
    // `AGENT_RUN_PREFIX` ('agent-') is a `usage.receipt.run_id` rule
    // (`spawn-outcome.js`), not a `route.bound.agent_id` one, and with 0 live
    // audit rows there is no sample of what a subject id looks like. Stripping
    // or lowercasing here would be a guess that silently invents joins.
    const rows = [
      ...spawn(AG1),
      audit({ subjectId: `agent-${AG1}`, total: 3, refuted: 0 }),
      audit({ subjectId: AG1.toUpperCase(), total: 3, refuted: 0 }),
      audit({ subjectId: ` ${AG1}`, total: 3, refuted: 0 }),
    ];
    const f = joinClaimAudits(rows);
    expect(f.joined).toBe(0);
    expect(f.unjoined_audits).toBe(3);
    expect(f.pass_rate).toBeNull();
    expect(f.by_agent).toEqual([]);
  });

  it('leaves every subjected audit unjoined when the ledger has no bind', () => {
    const rows = fixture().filter((e) => e.event === CLAIM_AUDIT_JOIN_EVENTS.audit);
    const f = joinClaimAudits(rows);
    expect(f.audits).toBe(6);
    expect(f.joined).toBe(0);
    expect(f.unjoined_audits).toBe(5);
    expect(f.no_subject_audits).toBe(1);
    expect(f.claims_total).toBe(0);
    expect(f.claims_refuted).toBe(0);
    expect(f.pass_rate).toBeNull();
  });

  it('an orphan bind is not in the default set', () => {
    // `joinRouteBinds` puts a bind whose `route.selected` receipt is absent in
    // `orphan_binds`, not `bound[]`, so this audit reads as unjoined. Pinned so
    // the difference from `spawn-outcome.js#collect` (which needs no receipt)
    // is a decision on the record rather than a surprise.
    const rows = [bound(AG1), audit({ subjectId: AG1, total: 3, refuted: 0 })];
    const f = joinClaimAudits(rows);
    expect(f.joined).toBe(0);
    expect(f.unjoined_audits).toBe(1);
  });

  it('uses a caller-supplied agent id set instead of the binds', () => {
    const rows = [bound(AG1), audit({ subjectId: AG1, total: 4, refuted: 1 })];
    const f = joinClaimAudits(rows, { agentIds: [AG1] });
    expect(f.joined).toBe(1);
    expect(f.claims_total).toBe(4);
    expect(f.by_agent).toEqual([
      { agent_id: AG1, audits: 1, claims_total: 4, claims_refuted: 1, pass_rate: 0.75 },
    ]);
  });

  it('ignores non-string members of a supplied set and accepts a Set', () => {
    const rows = [audit({ subjectId: AG1, total: 4, refuted: 1 })];
    expect(joinClaimAudits(rows, { agentIds: new Set([AG1]) }).joined).toBe(1);
    expect(joinClaimAudits(rows, { agentIds: [null, 0, '', {}] }).joined).toBe(0);
  });

  it('falls back to the binds when opts carries no usable agentIds', () => {
    const expected = JSON.stringify(joinClaimAudits(fixture()));
    for (const opts of [undefined, null, {}, 'opts', { agentIds: null }, { agentIds: 7 }]) {
      expect(JSON.stringify(joinClaimAudits(fixture(), opts))).toBe(expected);
    }
  });

  it('is safe with a subject id spelled __proto__', () => {
    const rows = [audit({ subjectId: '__proto__', total: 2, refuted: 1 })];
    const f = joinClaimAudits(rows, { agentIds: ['__proto__'] });
    expect(f.by_agent).toEqual([
      { agent_id: '__proto__', audits: 1, claims_total: 2, claims_refuted: 1, pass_rate: 0.5 },
    ]);
    expect({}.audits).toBeUndefined();
  });
});

describe('joinClaimAudits() is order-independent and pure', () => {
  it('serializes several permutations of one input identically', () => {
    const rows = fixture();
    const expected = JSON.stringify(joinClaimAudits(rows));
    expect(JSON.stringify(joinClaimAudits(shuffled(rows)))).toBe(expected);
    expect(JSON.stringify(joinClaimAudits(reversedShuffle(rows)))).toBe(expected);
    expect(JSON.stringify(joinClaimAudits([...rows].reverse()))).toBe(expected);
  });

  it('skips a non-object line instead of throwing', () => {
    const rows = [null, undefined, 7, 'route.bound', ...fixture()];
    expect(JSON.stringify(joinClaimAudits(rows))).toBe(JSON.stringify(joinClaimAudits(fixture())));
  });

  it('does not mutate the input', () => {
    const rows = fixture();
    const before = JSON.stringify(rows);
    joinClaimAudits(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('the replay barrel', () => {
  it('exports joinClaimAudits and its event names', () => {
    expect(typeof joinClaimAudits).toBe('function');
    expect(CLAIM_AUDIT_JOIN_EVENTS).toEqual({ bind: 'route.bound', audit: 'review.claim_audit' });
    expect(Object.isFrozen(CLAIM_AUDIT_JOIN_EVENTS)).toBe(true);
  });
});
