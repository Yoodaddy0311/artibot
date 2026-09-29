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
 *   - THE LIVE MIX OF CAUSES. `liveShape()` below copies the COMPOSITION measured
 *     in the central ledger at 2026-09-29T05:29Z (59 ended, 46 covered, 13
 *     skipped: 6 empty `claude -p` runs, 2 early bare failures, 5 catalog-drift
 *     failures), with synthetic ids. It proves the views split that mix the way
 *     the plan expects; it does not prove the live ledger still has that mix.
 *
 * The exclusion / cause-column API is imported from the module itself: the
 * `lib/replay/index.js` barrel re-exports only the original two names.
 *
 * @module tests/replay/session-coverage
 */

import { describe, expect, it } from 'vitest';
import {
  foldSessionCoverage,
  SESSION_COVERAGE_EVENTS,
} from '../../lib/replay/index.js';
import {
  emptyCoverageFold,
  foldCoverageViews,
  parseSessionIdList,
} from '../../lib/replay/session-coverage.js';

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

// ---------------------------------------------------------------------------
// Instrumentation added for the ④ census (no threshold moves): skipped-session
// causes, the catalog-drift column, and an exclusion that never hides the raw
// numbers. Everything below is still pure — arrays in, plain objects out.
// ---------------------------------------------------------------------------

/**
 * `ended === with_receipts + skipped` and the cause columns partition `skipped`.
 * Written as a predicate so a CONTROL test can prove it is able to fail.
 */
function identityHolds(view) {
  const causeTotal = Object.values(view.skipped_by_cause).reduce((a, b) => a + b, 0);
  return view.ended === view.with_receipts + view.skipped && causeTotal === view.skipped;
}

const SKIP_BARE = {
  receipt_status: 'skipped', receipts: 0, appended: 0, coverage: null, reason: 'no-receipts',
};

const pad = (n) => String(n).padStart(3, '0');

/**
 * The composition of the central ledger at 2026-09-29T05:29Z, synthetic ids:
 *   46 covered · 2 early bare failures · 5 catalog-drift failures (opus-5-5 not
 *   in the installed catalog, coverage 0) · 6 empty `claude -p` runs = 59 ended.
 */
const LIVE_EMPTY_IDS = Array.from({ length: 6 }, (_, i) => `live-empty-${i}`);

function liveShape() {
  const rows = [];
  for (let i = 0; i < 46; i += 1) rows.push(receipt(`live-cov-${pad(i)}`, 0), ended(`live-cov-${pad(i)}`));
  for (let i = 0; i < 2; i += 1) rows.push(ended(`live-old-${i}`, SKIP_BARE));
  for (let i = 0; i < 5; i += 1) {
    rows.push(ended(`live-drift-${i}`, { ...SKIP_BARE, coverage: 0, unresolved_models: ['claude-opus-5-5'] }));
  }
  for (const sid of LIVE_EMPTY_IDS) rows.push(ended(sid, SKIP_BARE));
  return rows;
}

describe('foldSessionCoverage() names the skipped sessions and their causes', () => {
  it('counts an ended session with no readable receipt as skipped — by the JOIN', () => {
    const f = foldSessionCoverage(fixture());
    // FALLBACK (no receipt, status skipped) and GHOST (no receipt, status
    // appended): the join, not the hook's claim, decides who is skipped.
    expect(f.skipped).toBe(2);
    expect(f.ended).toBe(f.with_receipts + f.skipped);
  });

  it('SKIPPED IS NOT THE SELF-REPORT: receipt_status skipped WITH a receipt row is covered', () => {
    const f = foldSessionCoverage([
      receipt('sess-claims-skip', 0),
      ended('sess-claims-skip', { receipt_status: 'skipped', reason: 'no-receipts' }),
    ]);
    expect(f.by_status).toEqual({ skipped: 1 });
    expect(f.with_receipts).toBe(1);
    expect(f.skipped).toBe(0);
    expect(f.skipped_by_cause).toEqual({});
  });

  it.each([
    ['no-receipts', 'no-receipts'],
    ['no-receipts:unreadable', 'no-receipts:unreadable'],
    ['no-receipts:no-entries', 'no-receipts:no-entries'],
    ['no-receipts:all-unresolved', 'no-receipts:all-unresolved'],
    [null, 'null'],
    ['', 'null'],
    [7, 'null'],
    ['no-transcript', 'no-transcript'],
    ['parse-failed:transcript exploded', 'parse-failed'],
    ['invalid-envelope:mission_id', 'invalid-envelope'],
    // NOT filed under the bare `no-receipts` column, and not passed through:
    ['no-receipts:UPPER', 'other'],
    ['no-receipts: two words', 'other'],
    ['no-receipts:', 'other'],
    ['Something went wrong', 'other'],
    [`x${'y'.repeat(60)}`, 'other'],
  ])('files the reason %j under the cause %j', (reason, cause) => {
    const f = foldSessionCoverage([
      ended('sess-cause', { receipt_status: 'skipped', reason }),
    ]);
    expect(f.skipped).toBe(1);
    expect(f.skipped_by_cause).toEqual({ [cause]: 1 });
  });

  it('keeps every cause column key-sorted and partitions the skipped sessions', () => {
    const f = foldSessionCoverage(shuffled(liveShape()));
    expect(Object.keys(f.skipped_by_cause)).toEqual([...Object.keys(f.skipped_by_cause)].sort());
    expect(identityHolds(f)).toBe(true);
  });

  it('reports the unresolved-models column for covered AND skipped sessions', () => {
    const f = foldSessionCoverage([
      // Covered, but the receipt stage saw a model it could not resolve: a
      // partial loss the ④ ratio cannot see (session 8ce16014 on 2026-09-29).
      receipt('sess-a', 0),
      ended('sess-a', { unresolved_models: ['claude-sonnet-5-5'] }),
      ended('sess-b', { ...SKIP_BARE, unresolved_models: ['claude-opus-5-5'] }),
      ended('sess-c', { ...SKIP_BARE, unresolved_models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }),
      ended('sess-d', { ...SKIP_BARE, unresolved_models: [] }),
    ]);
    expect(f.unresolved_models).toEqual({
      sessions: 3,
      skipped_sessions: 2,
      by_model: { 'claude-opus-5-5': 2, 'claude-sonnet-5-5': 2 },
    });
    expect(f.skipped).toBe(3);
  });

  it('counts a model once per session even when the row repeats it', () => {
    const f = foldSessionCoverage([
      ended('sess-rep', { ...SKIP_BARE, unresolved_models: ['m-1', 'm-1', 'm-1'] }),
    ]);
    expect(f.unresolved_models).toEqual({ sessions: 1, skipped_sessions: 1, by_model: { 'm-1': 1 } });
  });

  it.each([
    ['a string', 'claude-opus-5-5'],
    ['an object', { 'claude-opus-5-5': 1 }],
    ['null', null],
    ['an array of non-strings and empties', [1, '', null, {}]],
  ])('does not count unresolved_models that is %s', (_label, value) => {
    const f = foldSessionCoverage([ended('sess-junk', { ...SKIP_BARE, unresolved_models: value })]);
    expect(f.unresolved_models).toEqual({ sessions: 0, skipped_sessions: 0, by_model: {} });
  });

  it('gives a visible bucket to a model literally named __proto__', () => {
    const f = foldSessionCoverage([
      ended('sess-p', { ...SKIP_BARE, unresolved_models: ['__proto__'] }),
    ]);
    expect(Object.keys(f.unresolved_models.by_model)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(f.unresolved_models.by_model)).toBe(Object.prototype);
  });

  it('has zero columns, not missing ones, on an empty ledger', () => {
    const f = foldSessionCoverage([]);
    expect(f.skipped).toBe(0);
    expect(f.skipped_by_cause).toEqual({});
    expect(f.unresolved_models).toEqual({ sessions: 0, skipped_sessions: 0, by_model: {} });
  });

  it('leaves every pre-existing field exactly as it was', () => {
    const f = foldSessionCoverage(fixture());
    expect(f.ended).toBe(NORMAL + 5);
    expect(f.with_receipts).toBe(NORMAL + 3);
    expect(f.coverage).toBe((NORMAL + 3) / (NORMAL + 5));
    expect(f.by_status).toEqual({ appended: NORMAL + 3, failed: 1, skipped: 1 });
    expect(f.disagree.count).toBe(2);
  });
});

describe('emptyCoverageFold()', () => {
  it('is exactly the fold of nothing, so the two can never drift apart', () => {
    expect(emptyCoverageFold()).toEqual(foldSessionCoverage([]));
  });

  it('returns a fresh object every call', () => {
    const first = emptyCoverageFold();
    first.skipped_by_cause.mutated = 1;
    first.disagree.status_appended_no_receipt.push('x');
    expect(emptyCoverageFold()).toEqual(foldSessionCoverage([]));
  });
});

describe('parseSessionIdList()', () => {
  it('reads one id per line, sorted and unique', () => {
    expect(parseSessionIdList('b\na\nc\na\n')).toEqual({ ids: ['a', 'b', 'c'], ignored: 0 });
  });

  it('accepts list bullets, backticks, quotes, CRLF and surrounding blanks', () => {
    const text = ['- a', '* b', '+ c', '- `d`', '"e"', "'f'", '   g   ', ''].join('\r\n');
    expect(parseSessionIdList(text)).toEqual({ ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ignored: 0 });
  });

  it('skips blank lines and # comments without counting them as ignored', () => {
    expect(parseSessionIdList('# a heading\n\n   \n## sub\nx')).toEqual({ ids: ['x'], ignored: 0 });
  });

  it('counts every entry that is not a session id instead of silently dropping it', () => {
    const text = ['has space', 'a,b', '../../etc/passwd', 'C:\\temp\\x', '-', `z${'y'.repeat(128)}`, 'ok'].join('\n');
    expect(parseSessionIdList(text)).toEqual({ ids: ['ok'], ignored: 6 });
  });

  it('reads the exclusion document the way the leader wrote it', () => {
    // Same line kinds as `ledger-exclusions-20260929.md`: a heading, prose,
    // a bulleted id list, prose again. 4 prose lines, 6 ids.
    const doc = [
      '# Ledger contamination to exclude from live census (2026-09-29)',
      '',
      'Source: limb W1-6 `ca04-host-ask-probe` (commit 6094ed98). Six empty runs.',
      '',
      'Exclude these session_ids from Observe \u2463 (session coverage):',
      '',
      '- 3eb8466c-6df6-4193-b880-a30529776aa0',
      '- fd7bc579-aa62-4bc6-a93d-cfc93ef2d2e5',
      '- b5369386-eee6-4a70-b486-cdf0876149bf',
      '- 65a342a1-c4f1-4746-b5b4-f7a57dccbc99',
      '- 860c8b93-6e48-4b16-8725-6801dfe42355',
      '- a5d7a7b8-bc73-4f41-aceb-f0747c13c1a0',
      '',
      "The limb's positive control (04:44:12Z): these 6 ids have 18 rows.",
      '',
      'M0 T1 must report coverage both with and without these ids.',
      '',
    ].join('\n');
    const parsed = parseSessionIdList(doc);
    expect(parsed.ids).toHaveLength(6);
    expect(parsed.ids).toContain('3eb8466c-6df6-4193-b880-a30529776aa0');
    expect(parsed.ids).toContain('a5d7a7b8-bc73-4f41-aceb-f0747c13c1a0');
    expect(parsed.ignored).toBe(4);
  });

  it('reads a comma-separated list in csv mode, skipping empty pieces', () => {
    expect(parseSessionIdList('a, b ,,c,', 'csv')).toEqual({ ids: ['a', 'b', 'c'], ignored: 0 });
    expect(parseSessionIdList('a,b c', 'csv')).toEqual({ ids: ['a'], ignored: 1 });
  });

  it('does not split a line on commas in line mode', () => {
    // A prose line with commas must stay ONE ignored entry, not a handful of
    // fragments some of which happen to look like ids.
    expect(parseSessionIdList('done, ok, fine')).toEqual({ ids: [], ignored: 1 });
  });

  it.each([[undefined], [null], [42], [{}], [['a']]])('treats %j as an empty list', (input) => {
    expect(parseSessionIdList(input)).toEqual({ ids: [], ignored: 0 });
  });
});

describe('foldCoverageViews() keeps the raw view next to the excluded one', () => {
  it('returns the raw fold and nothing else when nothing is excluded', () => {
    const rows = liveShape();
    const raw = foldSessionCoverage(rows);
    for (const excludeSessions of [undefined, null, [], new Set(), ['', 7, null]]) {
      const views = foldCoverageViews(rows, { excludeSessions });
      expect(views.unexcluded).toEqual(raw);
      expect(views.excluded).toBeNull();
      expect(views.exclusion).toBeNull();
    }
    expect(foldCoverageViews(rows).excluded).toBeNull();
  });

  it('reproduces the live 59/46 and 53/46 split when the six empty runs are excluded', () => {
    const views = foldCoverageViews(liveShape(), { excludeSessions: LIVE_EMPTY_IDS });

    expect(views.unexcluded.ended).toBe(59);
    expect(views.unexcluded.with_receipts).toBe(46);
    expect(views.unexcluded.skipped).toBe(13);
    expect(views.unexcluded.coverage).toBe(46 / 59);

    expect(views.excluded.ended).toBe(53);
    expect(views.excluded.with_receipts).toBe(46);
    expect(views.excluded.skipped).toBe(7);
    expect(views.excluded.coverage).toBe(46 / 53);

    // 59 - 6 = 53 and 53 - 46 = 7: the plan's own arithmetic.
    expect(views.unexcluded.ended - views.excluded.ended).toBe(LIVE_EMPTY_IDS.length);
    expect(views.excluded.skipped).toBe(views.unexcluded.skipped - LIVE_EMPTY_IDS.length);
  });

  it('splits the live causes: bare everywhere, catalog drift in the seven that remain', () => {
    const views = foldCoverageViews(liveShape(), { excludeSessions: LIVE_EMPTY_IDS });
    expect(views.unexcluded.skipped_by_cause).toEqual({ 'no-receipts': 13 });
    expect(views.excluded.skipped_by_cause).toEqual({ 'no-receipts': 7 });
    // Excluding empty runs must not touch the drift evidence: 5 of the 7 that
    // remain are opus-5-5 sessions, and the empties never had a model to lose.
    for (const view of [views.unexcluded, views.excluded]) {
      expect(view.unresolved_models).toEqual({
        sessions: 5, skipped_sessions: 5, by_model: { 'claude-opus-5-5': 5 },
      });
    }
  });

  it('holds ended = with_receipts + skipped in BOTH views, and the causes partition skipped', () => {
    const views = foldCoverageViews(liveShape(), { excludeSessions: LIVE_EMPTY_IDS });
    expect(identityHolds(views.unexcluded)).toBe(true);
    expect(identityHolds(views.excluded)).toBe(true);
  });

  it('CONTROL: the identity check is able to fail', () => {
    const good = foldSessionCoverage(liveShape());
    expect(identityHolds(good)).toBe(true);
    expect(identityHolds({ ...good, skipped: good.skipped + 1 })).toBe(false);
    expect(identityHolds({ ...good, with_receipts: good.with_receipts - 1 })).toBe(false);
    expect(identityHolds({ ...good, skipped_by_cause: { ...good.skipped_by_cause, extra: 1 } })).toBe(false);
  });

  it('builds the excluded view from independent inputs, not by re-filtering', () => {
    // Expected values come from folding two DISJOINT row sets that were built
    // separately: "kept" alone is the excluded view, "kept + dropped" is the raw one.
    const kept = [receipt('k-1', 0), ended('k-1'), receipt('k-2', 0), ended('k-2'), ended('k-3', SKIP_BARE)];
    const dropped = [ended('d-1', SKIP_BARE), ended('d-2', { ...SKIP_BARE, reason: 'no-transcript' })];
    const views = foldCoverageViews([...kept, ...dropped], { excludeSessions: ['d-1', 'd-2'] });
    expect(views.excluded).toEqual(foldSessionCoverage(kept));
    expect(views.unexcluded).toEqual(foldSessionCoverage([...kept, ...dropped]));
    expect(views.excluded.ended).toBe(3);
    expect(views.unexcluded.ended).toBe(5);
  });

  it('reports what the exclusion touched', () => {
    const views = foldCoverageViews(liveShape(), {
      excludeSessions: [...LIVE_EMPTY_IDS, 'not-in-this-ledger'],
    });
    expect(views.exclusion).toEqual({
      requested: 7,
      matched_ended: 6,
      unmatched: ['not-in-this-ledger'],
      with_receipts: [],
    });
    expect(views.unexcluded.ended - views.excluded.ended).toBe(views.exclusion.matched_ended);
  });

  it('an id that is not in the ledger changes nothing and is named', () => {
    const rows = liveShape();
    const views = foldCoverageViews(rows, { excludeSessions: ['ghost-1'] });
    expect(views.excluded).toEqual(views.unexcluded);
    expect(views.exclusion).toEqual({ requested: 1, matched_ended: 0, unmatched: ['ghost-1'], with_receipts: [] });
  });

  it('FLAGS an excluded session that DID produce a receipt', () => {
    // R2-1: only sessions with no model call belong on an exclusion list. A
    // covered session on it lowers the numerator and the denominator together,
    // and that is precisely the mistake the report has to make visible.
    const views = foldCoverageViews(liveShape(), { excludeSessions: ['live-cov-000', 'live-empty-0'] });
    expect(views.exclusion.with_receipts).toEqual(['live-cov-000']);
    expect(views.exclusion.matched_ended).toBe(2);
    expect(views.excluded.ended).toBe(57);
    expect(views.excluded.with_receipts).toBe(45);
  });

  it('removes a receipt-only session from the informational counts, and names it unmatched', () => {
    const rows = [receipt('ro-1', 0), receipt('cov', 0), ended('cov')];
    const views = foldCoverageViews(rows, { excludeSessions: ['ro-1'] });
    expect(views.unexcluded.receipt_only_sessions).toEqual(['ro-1']);
    expect(views.excluded.receipt_only_sessions).toEqual([]);
    expect(views.excluded.ended).toBe(1);
    expect(views.exclusion.unmatched).toEqual(['ro-1']);
    expect(views.exclusion.matched_ended).toBe(0);
  });

  it('never excludes a malformed ended row, which has no id to match', () => {
    const rows = [...liveShape(), line({ event: 'session.ended', data: {} })];
    const views = foldCoverageViews(rows, { excludeSessions: LIVE_EMPTY_IDS });
    expect(views.unexcluded.malformed_ended).toBe(1);
    expect(views.excluded.malformed_ended).toBe(1);
  });

  it('removes both rows of a re-fired session', () => {
    const rows = [
      ended('rf', SKIP_BARE),
      ended('rf', { ...SKIP_BARE, reason: 'already-recorded' }),
      ended('keep', SKIP_BARE),
    ];
    const views = foldCoverageViews(rows, { excludeSessions: ['rf'] });
    expect(views.unexcluded.duplicate_ended_rows).toBe(1);
    expect(views.excluded.duplicate_ended_rows).toBe(0);
    expect(views.excluded.ended).toBe(1);
  });

  it('accepts any iterable of ids and ignores entries that are not ids', () => {
    const rows = liveShape();
    const fromArray = foldCoverageViews(rows, { excludeSessions: LIVE_EMPTY_IDS });
    const fromSet = foldCoverageViews(rows, { excludeSessions: new Set(LIVE_EMPTY_IDS) });
    const noisy = foldCoverageViews(rows, { excludeSessions: [...LIVE_EMPTY_IDS, '', 7, null, {}] });
    expect(fromSet).toEqual(fromArray);
    expect(noisy).toEqual(fromArray);
  });

  it('does not mutate its input', () => {
    const rows = liveShape();
    const frozen = Object.freeze(rows.map((r) => Object.freeze({ ...r, data: Object.freeze({ ...r.data }) })));
    const ids = Object.freeze([...LIVE_EMPTY_IDS]);
    const before = JSON.stringify(frozen);
    expect(() => foldCoverageViews(frozen, { excludeSessions: ids })).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it('serializes a shuffled input of distinct sessions identically', () => {
    const rows = liveShape();
    const a = foldCoverageViews(rows, { excludeSessions: LIVE_EMPTY_IDS });
    const b = foldCoverageViews(shuffled(rows), { excludeSessions: [...LIVE_EMPTY_IDS].reverse() });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('treats a non-array ledger as an empty one', () => {
    const views = foldCoverageViews(undefined, { excludeSessions: ['x'] });
    expect(views.unexcluded).toEqual(emptyCoverageFold());
    expect(views.excluded).toEqual(emptyCoverageFold());
    expect(views.exclusion).toEqual({ requested: 1, matched_ended: 0, unmatched: ['x'], with_receipts: [] });
  });
});

describe('foldCoverageViews() holds its identities on 300 generated ledgers', () => {
  /** Reproducible PRNG (mulberry32): a failure names its seed. */
  function prng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const REASONS = [
    null, 'no-receipts', 'no-receipts:unreadable', 'no-receipts:no-entries',
    'no-receipts:all-unresolved', 'no-transcript', 'parse-failed:boom', 'free text here', 'no-receipts:BAD',
  ];
  const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-x'];

  function randomLedger(seed) {
    const rand = prng(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const rows = [];
    const sids = [];
    const count = 1 + Math.floor(rand() * 40);
    for (let i = 0; i < count; i += 1) {
      const sid = `rnd-${seed}-${i}`;
      sids.push(sid);
      if (rand() < 0.6) rows.push(receipt(sid, 0));
      if (rand() < 0.9) {
        const unresolved = Array.from({ length: Math.floor(rand() * 3) }, () => pick(MODELS));
        rows.push(ended(sid, {
          receipt_status: pick(['appended', 'skipped', 'failed']),
          reason: pick(REASONS),
          unresolved_models: unresolved,
        }));
        if (rand() < 0.1) rows.push(ended(sid, { receipt_status: 'skipped', reason: 'already-recorded' }));
      }
    }
    if (rand() < 0.3) rows.push(line({ event: 'session.ended', data: {} }));
    const chosen = sids.filter(() => rand() < 0.3);
    if (rand() < 0.5) chosen.push(`unknown-${seed}`);
    return { rows, chosen };
  }

  it('keeps ended = with_receipts + skipped, the cause partition and the ratio in every view', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { rows, chosen } = randomLedger(seed);
      const views = foldCoverageViews(rows, { excludeSessions: chosen });
      const tag = `seed ${seed}`;

      expect(views.unexcluded, tag).toEqual(foldSessionCoverage(rows));
      const measured = [views.unexcluded, ...(views.excluded === null ? [] : [views.excluded])];
      for (const view of measured) {
        expect(identityHolds(view), tag).toBe(true);
        expect(view.coverage, tag).toBe(view.ended === 0 ? null : view.with_receipts / view.ended);
        expect(view.unresolved_models.skipped_sessions, tag).toBeLessThanOrEqual(view.skipped);
        expect(view.unresolved_models.skipped_sessions, tag).toBeLessThanOrEqual(view.unresolved_models.sessions);
        expect(view.unresolved_models.sessions, tag).toBeLessThanOrEqual(view.ended);
      }

      if (chosen.length === 0) {
        expect(views.excluded, tag).toBeNull();
        continue;
      }
      expect(views.excluded.ended, tag).toBeLessThanOrEqual(views.unexcluded.ended);
      expect(views.excluded.with_receipts, tag).toBeLessThanOrEqual(views.unexcluded.with_receipts);
      expect(views.unexcluded.ended - views.excluded.ended, tag).toBe(views.exclusion.matched_ended);
      expect(views.exclusion.requested, tag).toBe(new Set(chosen).size);
      expect(views.exclusion.matched_ended + views.exclusion.unmatched.length, tag).toBe(views.exclusion.requested);
    }
  });
});
