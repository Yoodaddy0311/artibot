/**
 * Unit contract for the session-coverage fold (`lib/replay/session-coverage.js`).
 *
 * The fold answers Observe axis ④: of the sessions that ENDED, how many
 * produced at least one `usage.receipt` row. The denominator is the
 * `session.ended` row `scripts/hooks/session-end.js#recordSessionEnded` writes
 * after the receipt stage REGARDLESS of that stage's outcome; the numerator is
 * a JOIN on the envelope `session_id`, not the hook's own `receipt_status`.
 *
 * ── WHAT THIS SUITE CANNOT SEE (repo rules §9) ──────────────────────────────
 *   - ZERO LIVE LINES. Every row below is hand-built in the shape
 *     `appendSessionEndedEvent` writes. Nothing here was read from a real
 *     ledger, so nothing here says what live coverage IS.
 *   - THE WRITER. That the hook actually fires on SessionEnd, and that its
 *     `receipt_status` values are the ones spelled here, is the hook suite's
 *     business; this suite pins arithmetic over a given array.
 *   - FIXTURE SCALE. 40-odd sessions, a handful of rows each. Nothing about
 *     the fold at ledger size, and nothing about read cost.
 *   - PRICING. A `usage.receipt` row counts whether or not it carries a cost.
 *
 * @module tests/replay/session-coverage
 */

import { describe, expect, it } from 'vitest';
import {
  foldSessionCoverage,
  SESSION_COVERAGE_EVENTS,
} from '../../lib/replay/index.js';

const MISSION = 'M-20260914-001';

let seqCounter = 0;

/** A minimal, well-formed envelope around `fields`. */
function line(fields, ts = '2026-09-14T02:00:00.000Z') {
  seqCounter += 1;
  return {
    v: 1, ts, mission_id: MISSION, source: 'hook', pid: 4242, seq: seqCounter, ...fields,
  };
}

/** A `session.ended` row, as `appendSessionEndedEvent` writes it. */
function ended(sessionId, data = {}) {
  return line({
    event: 'session.ended',
    session_id: sessionId,
    idempotency_key: `session.ended:${sessionId}`,
    data: {
      receipt_status: 'appended',
      receipts: 2,
      appended: 2,
      rejected: 0,
      deduped: 0,
      coverage: 1,
      reason: null,
      unresolved_models: [],
      transcript_present: true,
      session_fallback: false,
      ...data,
    },
  });
}

/** A `usage.receipt` row for one session. */
function receipt(sessionId, n = 0) {
  return line({
    event: 'usage.receipt',
    session_id: sessionId,
    idempotency_key: `usage.receipt:${sessionId}:${n}`,
    data: { model_identity: { canonical: 'claude-opus-5' }, cost: { total: 0.01 } },
  });
}

const NORMAL = 40;
const REFIRE = 'sess-refire';
const PARTIAL = 'sess-partial';
const FALLBACK = 'session-1757800000000';
const PREVOCAB = 'sess-prevocab';
const GHOST = 'sess-ghost';
const FAIL_WITH_RECEIPT = 'sess-fail-rcpt';

/** The 40 ordinary sessions: ended, appended, receipts present. */
function normalRows() {
  const rows = [];
  for (let i = 0; i < NORMAL; i += 1) {
    const sid = `sess-${String(i).padStart(3, '0')}`;
    rows.push(receipt(sid, 0), receipt(sid, 1), ended(sid));
  }
  return rows;
}

/**
 * Everything except the re-fire case. First-row-wins is defined over INPUT
 * order, so the re-fire pair is the one group a shuffle may legitimately move.
 */
function fixtureWithoutRefire() {
  return [
    ...normalRows(),
    receipt(PARTIAL, 0),
    ended(PARTIAL, { receipt_status: 'appended', appended: 1, rejected: 1, reason: 'append-failed' }),
    ended(FALLBACK, { receipt_status: 'skipped', reason: 'no-session-id', session_fallback: true, receipts: 0, appended: 0, coverage: null }),
    receipt(PREVOCAB, 0),
    receipt(PREVOCAB, 1),
    ended(GHOST, { receipt_status: 'appended', appended: 3 }),
    receipt(FAIL_WITH_RECEIPT, 0),
    ended(FAIL_WITH_RECEIPT, { receipt_status: 'failed', appended: 0, rejected: 2, reason: 'append-failed' }),
  ];
}

/** The full fixture: 45 ended sessions, one of them re-fired. */
function fixture() {
  return [
    ...fixtureWithoutRefire(),
    receipt(REFIRE, 0),
    ended(REFIRE, { receipt_status: 'appended' }),
    ended(REFIRE, { receipt_status: 'skipped', reason: 'already-recorded', appended: 0, deduped: 2 }),
  ];
}

/** Deterministic shuffle (same construction as `tests/replay/route-bind.test.js`). */
function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 7919) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('the barrel exports the fold', () => {
  it('exports both names from lib/replay/index.js', () => {
    expect(typeof foldSessionCoverage).toBe('function');
    expect(SESSION_COVERAGE_EVENTS).toEqual({ ended: 'session.ended', receipt: 'usage.receipt' });
  });
});

describe('foldSessionCoverage() on nothing', () => {
  it('reports coverage null, NOT zero, for an empty denominator', () => {
    // 0 ended sessions means UNMEASURED. A 0 here would read as "every session
    // that ended produced nothing", which is a finding; "no session ended" is
    // the absence of one.
    const f = foldSessionCoverage([]);
    expect(f.coverage).toBeNull();
    expect(f.coverage).not.toBe(0);
    expect(f.ended).toBe(0);
    expect(f.with_receipts).toBe(0);
    expect(f.receipt_sessions).toBe(0);
    expect(f.fallback_sessions).toBe(0);
    expect(f.duplicate_ended_rows).toBe(0);
    expect(f.malformed_ended).toBe(0);
    expect(f.by_status).toEqual({});
    expect(f.by_reason).toEqual({});
    expect(f.receipt_only_sessions).toEqual([]);
    expect(f.disagree).toEqual({
      status_appended_no_receipt: [], receipt_but_status_not_appended: [], count: 0,
    });
  });

  it('treats a non-array input as an empty ledger', () => {
    const empty = JSON.stringify(foldSessionCoverage([]));
    expect(JSON.stringify(foldSessionCoverage(undefined))).toBe(empty);
    expect(JSON.stringify(foldSessionCoverage('x'))).toBe(empty);
    expect(JSON.stringify(foldSessionCoverage(null))).toBe(empty);
    expect(JSON.stringify(foldSessionCoverage(42))).toBe(empty);
  });
});

describe('foldSessionCoverage() over a 45-session fixture', () => {
  it('counts every ended session once and joins receipts on session_id', () => {
    const f = foldSessionCoverage(fixture());
    expect(f.ended).toBe(NORMAL + 5);
    expect(f.with_receipts).toBe(NORMAL + 3);
    expect(f.coverage).toBe((NORMAL + 3) / (NORMAL + 5));
  });

  it('RE-FIRE: a second session.ended row bumps the duplicate count only', () => {
    // `ended --resume` fires SessionEnd twice. The FIRST row is the session's
    // self-report; the second is a deduped no-op that must not become a second
    // session, and must not overwrite the first row's status.
    const f = foldSessionCoverage(fixture());
    expect(f.duplicate_ended_rows).toBe(1);
    expect(f.by_status.appended).toBe(NORMAL + 3);
    expect(f.by_status.skipped).toBe(1);
    expect(f.by_reason['already-recorded']).toBeUndefined();
    expect(foldSessionCoverage(fixtureWithoutRefire()).ended).toBe(f.ended - 1);
  });

  it('PARTIAL FAILURE: appended=1 rejected=1 with a receipt row still counts covered', () => {
    const rows = [
      receipt(PARTIAL, 0),
      ended(PARTIAL, { receipt_status: 'appended', appended: 1, rejected: 1, reason: 'append-failed' }),
    ];
    const f = foldSessionCoverage(rows);
    expect(f.with_receipts).toBe(1);
    expect(f.coverage).toBe(1);
    expect(f.disagree.count).toBe(0);
    expect(f.by_reason).toEqual({ 'append-failed': 1 });
  });

  it('SESSION_FALLBACK: a synthesized-id session stays in the denominator', () => {
    // Excluding it would shrink the denominator and INFLATE coverage — the one
    // error the `session_fallback` row exists to prevent.
    const f = foldSessionCoverage(fixture());
    expect(f.fallback_sessions).toBe(1);
    expect(f.by_status.skipped).toBe(1);
    expect(f.by_reason['no-session-id']).toBe(1);
    const only = foldSessionCoverage([
      ended(FALLBACK, { receipt_status: 'skipped', reason: 'no-session-id', session_fallback: true }),
    ]);
    expect(only.ended).toBe(1);
    expect(only.with_receipts).toBe(0);
    expect(only.coverage).toBe(0);
    expect(only.fallback_sessions).toBe(1);
  });

  it('PRE-VOCAB RECEIPT: receipts with no session.ended row are listed apart', () => {
    // `usage.receipt` predates `session.ended`; those sessions have a numerator
    // and no denominator. Counting them as covered would push coverage over 1.
    const f = foldSessionCoverage(fixture());
    expect(f.receipt_only_sessions).toEqual([PREVOCAB]);
    expect(f.receipt_sessions).toBe(NORMAL + 4);
    expect(f.coverage).toBeLessThanOrEqual(1);
  });

  it('DISAGREE: lists both directions of self-report vs join mismatch', () => {
    // 존재 ≠ 성공 ≠ 결과. `receipt_status: 'appended'` says the hook believed it
    // wrote; the join says whether a row is there to read.
    const f = foldSessionCoverage(fixture());
    expect(f.disagree.status_appended_no_receipt).toEqual([GHOST]);
    expect(f.disagree.receipt_but_status_not_appended).toEqual([FAIL_WITH_RECEIPT]);
    expect(f.disagree.status_appended_no_receipt.length).toBeGreaterThan(0);
    expect(f.disagree.receipt_but_status_not_appended.length).toBeGreaterThan(0);
    expect(f.disagree.count).toBe(
      f.disagree.status_appended_no_receipt.length
      + f.disagree.receipt_but_status_not_appended.length,
    );
  });

  it('sorts both disagree lists and every key of by_status / by_reason', () => {
    const f = foldSessionCoverage(shuffled(fixtureWithoutRefire()));
    for (const list of [f.disagree.status_appended_no_receipt, f.disagree.receipt_but_status_not_appended, f.receipt_only_sessions]) {
      expect(list).toEqual([...list].sort());
    }
    expect(Object.keys(f.by_status)).toEqual([...Object.keys(f.by_status)].sort());
    expect(Object.keys(f.by_reason)).toEqual([...Object.keys(f.by_reason)].sort());
  });

  it('buckets a missing or non-string status/reason under the key "null"', () => {
    const f = foldSessionCoverage([
      line({ event: 'session.ended', session_id: 'sess-x', data: {} }),
      line({ event: 'session.ended', session_id: 'sess-y', data: { receipt_status: 7, reason: 7 } }),
      line({ event: 'session.ended', session_id: 'sess-z' }),
    ]);
    expect(f.ended).toBe(3);
    expect(f.by_status).toEqual({ null: 3 });
    expect(f.by_reason).toEqual({ null: 3 });
  });
});

describe('foldSessionCoverage() arithmetic holds on the fixture', () => {
  const f = foldSessionCoverage(fixture());

  it('coverage is exactly with_receipts / ended', () => {
    expect(f.coverage).toBe(f.with_receipts / f.ended);
  });

  it('by_status partitions the ended sessions', () => {
    expect(Object.values(f.by_status).reduce((a, b) => a + b, 0)).toBe(f.ended);
    expect(Object.values(f.by_reason).reduce((a, b) => a + b, 0)).toBe(f.ended);
  });

  it('receipt_sessions splits into joined and receipt-only', () => {
    expect(f.receipt_sessions).toBe(f.with_receipts + f.receipt_only_sessions.length);
  });

  it('fallback and disagree counts never exceed the denominator', () => {
    expect(f.fallback_sessions).toBeLessThanOrEqual(f.ended);
    expect(f.disagree.count).toBeLessThanOrEqual(f.ended + f.receipt_only_sessions.length);
  });
});

describe('foldSessionCoverage() is order-independent', () => {
  it('serializes a shuffled input of distinct sessions identically', () => {
    const rows = fixtureWithoutRefire();
    expect(JSON.stringify(foldSessionCoverage(shuffled(rows))))
      .toBe(JSON.stringify(foldSessionCoverage(rows)));
  });

  it('a re-fire keeps the FIRST row in input order, not the earliest ts', () => {
    // The caller passes `readAllEvents` file order. Sorting by `ts` here would
    // make the answer depend on a clock this module is not allowed to read.
    const first = ended(REFIRE, { receipt_status: 'appended', reason: null });
    const second = ended(REFIRE, { receipt_status: 'skipped', reason: 'already-recorded' });
    expect(foldSessionCoverage([first, second]).by_status).toEqual({ appended: 1 });
    expect(foldSessionCoverage([second, first]).by_status).toEqual({ skipped: 1 });
  });
});

describe('foldSessionCoverage() skips malformed lines without throwing', () => {
  it('ignores non-objects, other events, and rows with no session_id', () => {
    const f = foldSessionCoverage([
      null,
      undefined,
      'nope',
      {},
      { event: 'tool.used', session_id: 'sess-other' },
      line({ event: 'session.ended', data: { receipt_status: 'appended' } }),
      line({ event: 'session.ended', session_id: '', data: { receipt_status: 'appended' } }),
      line({ event: 'usage.receipt', session_id: 42 }),
      receipt('sess-ok', 0),
      ended('sess-ok'),
    ]);
    expect(f.ended).toBe(1);
    expect(f.with_receipts).toBe(1);
    expect(f.coverage).toBe(1);
    expect(f.malformed_ended).toBe(2);
    expect(f.receipt_only_sessions).toEqual([]);
  });

  it('a ledger of only malformed lines is unmeasured, not zero coverage', () => {
    const f = foldSessionCoverage([null, {}, line({ event: 'session.ended' })]);
    expect(f.ended).toBe(0);
    expect(f.coverage).toBeNull();
    expect(f.malformed_ended).toBe(1);
  });
});
