/**
 * Contract for `lib/verification/verify-rate.js` — the pure reader that asks
 * how many Stop-hook `verify.completed` denominators were answered by a
 * `/verify` self-report.
 *
 * WHY THE CLASSIFICATION IS PER `verification_id` AND NOT PER LINE, pinned
 * here because it is the one thing a plausible implementation gets wrong.
 * `scripts/ledger/record-verify.mjs` writes FOUR lines for one self-report
 * (three layers plus the overall fold, `record-verify.mjs:46`), and only the
 * deterministic one carries `SELF_REPORT_NOTE` in `data.evidence[0].note`
 * (:315, read 2026-09-14). The other two layer lines are `unmeasured` with
 * EMPTY evidence — byte-identical in shape to the hook's own lines
 * (`scripts/hooks/dev-verify-gate.js:330`, `verify({ layers: {} })`). A reader
 * that classified line by line would therefore count every self-report as
 * three extra hook firings, inflating its own denominator by 75% and driving
 * the rate down. `a self-report run is not three hook firings` is that pin.
 *
 * WHAT A GREEN RUN HERE DOES NOT PROVE (rules §9):
 *  - That the numbers describe the live ledger. These are synthetic lines. The
 *    live ledger held 16 `verify.completed` of 810 non-blank lines at
 *    2026-09-14 14:31 KST — 4 hook firings, 0 self-reports, all four written
 *    inside the preceding ten minutes — so every rate below is measured
 *    against a fixture, and the fixture is larger than the history.
 *  - That the marker survives the writer. `verify-writer.js#fitLine` drops
 *    evidence entries to fit the 4096-byte line cap; these fixtures are built
 *    by hand and never pass through it. `tests/ledger/record-verify.test.js`
 *    owns that half.
 *  - Anything about upstream loss. This module never reads a file, so a line
 *    the ledger reader dropped is invisible here — only the CLI's census sees
 *    it.
 *
 * @module tests/verification/verify-rate
 */

import { describe, expect, it } from 'vitest';
import {
  computeVerifyRate,
  isSelfReportLine,
  SELF_REPORT_NOTE,
  VERIFY_COMPLETED_EVENT,
} from '../../lib/verification/verify-rate.js';
import { SELF_REPORT_NOTE as WRITER_NOTE } from '../../scripts/ledger/record-verify.mjs';

/** A well-formed stamp, so `ids.unknown_stamp` stays 0 unless a case asks for it. */
const STAMP = '20260914T120000Z';

let seq = 0;

/**
 * One `verify.completed` envelope. `seq` is unique per line because
 * `lib/runtime/ledger.js#dedupeKey` (:144) keys on session/source/pid/seq/ts —
 * two fixture lines that agreed on all five would be folded to one by the
 * reader the CLI uses, and the pure module would then be tested on a shape the
 * CLI can never hand it.
 *
 * @param {{session: string, vid: string, layer: string|null, result: string,
 *          note?: string, ts: string}} p
 * @returns {object}
 */
function line({ session, vid, layer, result, note, ts }) {
  seq += 1;
  const data = {
    result,
    evidence: note === undefined ? [] : [{ kind: 'command', command: '/verify', output: '', note }],
    verification_id: vid,
  };
  // The overall fold carries NO `layer` key on purpose (verify-writer.js:21-22).
  if (layer !== null) data.layer = layer;
  return {
    ts,
    session_id: session,
    event: VERIFY_COMPLETED_EVENT,
    source: 'gate',
    pid: 4242,
    seq,
    idempotency_key: `${vid}:${layer ?? 'overall'}`,
    data,
  };
}

/**
 * The four lines the Stop hook writes for one session end: every layer
 * `unmeasured`, evidence empty, no note anywhere.
 *
 * @param {{session: string, vid: string, ts: string}} p
 * @returns {object[]}
 */
function hookRun({ session, vid, ts }) {
  return [
    line({ session, vid, layer: 'deterministic', result: 'unmeasured', ts }),
    line({ session, vid, layer: 'behavioral', result: 'unmeasured', ts }),
    line({ session, vid, layer: 'operational', result: 'unmeasured', ts }),
    line({ session, vid, layer: null, result: 'unmeasured', ts }),
  ];
}

/**
 * The four lines `record-verify.mjs` writes for one `/verify` self-report. The
 * note rides on the deterministic line ONLY — the other three are the trap.
 *
 * @param {{session: string, vid: string, ts: string, result?: string}} p
 * @returns {object[]}
 */
function selfReportRun({ session, vid, ts, result = 'pass' }) {
  return [
    line({ session, vid, layer: 'deterministic', result, note: SELF_REPORT_NOTE, ts }),
    line({ session, vid, layer: 'behavioral', result: 'unmeasured', ts }),
    line({ session, vid, layer: 'operational', result: 'unmeasured', ts }),
    line({ session, vid, layer: null, result, ts }),
  ];
}

/**
 * The fixture the whole contract is stated against: two sessions the hook
 * fired in, one of which later self-reported.
 *
 * @returns {object[]}
 */
function briefFixture() {
  return [
    ...hookRun({ session: 'S1', vid: `v1-aaaaaaaaaaaa-${STAMP}`, ts: '2026-09-14T12:00:00.000Z' }),
    ...hookRun({ session: 'S2', vid: `v1-bbbbbbbbbbbb-${STAMP}`, ts: '2026-09-14T12:05:00.000Z' }),
    ...selfReportRun({ session: 'S1', vid: `v1-cccccccccccc-${STAMP}`, ts: '2026-09-14T12:10:00.000Z' }),
  ];
}

describe('verify-rate: the marker it keys on', () => {
  it('is byte-identical to the note the writer actually writes', () => {
    // Not a copy for readability: if these two strings ever drift, this reader
    // silently classifies every self-report as a hook firing and the rate reads
    // 0% with no error anywhere.
    expect(SELF_REPORT_NOTE).toBe(WRITER_NOTE);
  });

  it('names the same event the writer writes', () => {
    expect(VERIFY_COMPLETED_EVENT).toBe('verify.completed');
  });

  it('recognises the marker only in the FIRST evidence entry', () => {
    const ts = '2026-09-14T12:00:00.000Z';
    const marked = line({
      session: 'S', vid: `v1-aaaaaaaaaaaa-${STAMP}`, layer: 'deterministic', result: 'pass', note: SELF_REPORT_NOTE, ts,
    });
    expect(isSelfReportLine(marked)).toBe(true);

    // `fitLine` drops evidence from the END, which is why the writer puts the
    // marker first (record-verify.mjs:65). A marker found anywhere else is a
    // line this reader has no contract with.
    const trailing = line({ session: 'S', vid: `v1-aaaaaaaaaaaa-${STAMP}`, layer: 'deterministic', result: 'pass', ts });
    trailing.data.evidence = [{ kind: 'command', command: 'x', output: '' }, { note: SELF_REPORT_NOTE }];
    expect(isSelfReportLine(trailing)).toBe(false);
  });

  it('never throws on a shape it was not given', () => {
    for (const bad of [null, undefined, 0, '', [], {}, { data: null }, { data: { evidence: 'no' } }]) {
      expect(isSelfReportLine(bad)).toBe(false);
    }
  });
});

describe('verify-rate: the brief fixture', () => {
  it('answers one of two hook firings', () => {
    const r = computeVerifyRate(briefFixture());

    expect(r.lines).toEqual({ total: 12, verify_completed: 12, skipped: 0 });
    expect(r.ids).toEqual({ hook: 2, self_report: 1, other: 0, unknown_stamp: 0 });
    expect(r.sessions).toEqual({ hook: 2, self_report: 1, answered: 1, rate: 0.5 });
    expect(r.firings).toEqual({ hook: 2, answered: 1, unordered: 0, rate: 0.5 });
  });

  it('keeps two sessions apart when their hook fires share one verification_id', () => {
    // NOT hypothetical. The hook's verdict is the constant `verify({layers:{}})`,
    // so its hash never varies and only the SECOND-resolution stamp separates
    // two firings. Measured 2026-09-14 14:47 KST: five back-to-back calls
    // returned one id (`v1-83866286c2d8-20260914T054755Z`, 5 of 5 identical),
    // and all 13 verification_ids in this machine's live ledger carry that same
    // hash. Two Stop hooks landing in one second therefore collide, and a
    // reader keyed on the id alone would fold them into ONE firing — losing
    // denominator exactly when the machine is busy enough to produce the
    // collision.
    const shared = `v1-83866286c2d8-${STAMP}`;
    const r = computeVerifyRate([
      ...hookRun({ session: 'S1', vid: shared, ts: '2026-09-14T12:00:00.000Z' }),
      ...hookRun({ session: 'S2', vid: shared, ts: '2026-09-14T12:00:00.000Z' }),
      ...selfReportRun({ session: 'S2', vid: `v1-cccccccccccc-${STAMP}`, ts: '2026-09-14T12:05:00.000Z' }),
    ]);

    expect(r.ids).toEqual({ hook: 2, self_report: 1, other: 0, unknown_stamp: 0 });
    expect(r.sessions).toEqual({ hook: 2, self_report: 1, answered: 1, rate: 0.5 });
    expect(r.firings).toEqual({ hook: 2, answered: 1, unordered: 0, rate: 0.5 });
  });

  it('a self-report run is not three hook firings (per-id classification)', () => {
    // The trap stated on its own: three of the four lines of a self-report are
    // `unmeasured` with empty evidence, indistinguishable from the hook's at
    // line level. One session, one self-report, NO hook fire at all.
    const r = computeVerifyRate(
      selfReportRun({ session: 'S1', vid: `v1-cccccccccccc-${STAMP}`, ts: '2026-09-14T12:10:00.000Z' }),
    );

    expect(r.ids.hook).toBe(0);
    expect(r.ids.self_report).toBe(1);
    expect(r.lines.verify_completed).toBe(4);
  });
});

describe('verify-rate: ordering', () => {
  it('counts a self-report that landed BEFORE the firing as a session answer, not a firing answer', () => {
    // Both numbers are real and they are not the same question. The session
    // DID report a /verify; that report cannot have been about a hook fire
    // that had not happened yet.
    const events = [
      ...selfReportRun({ session: 'S1', vid: `v1-cccccccccccc-${STAMP}`, ts: '2026-09-14T11:00:00.000Z' }),
      ...hookRun({ session: 'S1', vid: `v1-aaaaaaaaaaaa-${STAMP}`, ts: '2026-09-14T12:00:00.000Z' }),
    ];

    const r = computeVerifyRate(events);

    expect(r.sessions).toEqual({ hook: 1, self_report: 1, answered: 1, rate: 1 });
    expect(r.firings).toEqual({ hook: 1, answered: 0, unordered: 0, rate: 0 });
  });

  it('answers a firing from a self-report at the same instant', () => {
    const ts = '2026-09-14T12:00:00.000Z';
    const r = computeVerifyRate([
      ...hookRun({ session: 'S1', vid: `v1-aaaaaaaaaaaa-${STAMP}`, ts }),
      ...selfReportRun({ session: 'S1', vid: `v1-cccccccccccc-${STAMP}`, ts }),
    ]);

    expect(r.firings.answered).toBe(1);
  });

  it('never answers a firing from another session', () => {
    const r = computeVerifyRate([
      ...hookRun({ session: 'S1', vid: `v1-aaaaaaaaaaaa-${STAMP}`, ts: '2026-09-14T12:00:00.000Z' }),
      ...selfReportRun({ session: 'S2', vid: `v1-cccccccccccc-${STAMP}`, ts: '2026-09-14T12:10:00.000Z' }),
    ]);

    expect(r.sessions).toEqual({ hook: 1, self_report: 1, answered: 0, rate: 0 });
    expect(r.firings).toEqual({ hook: 1, answered: 0, unordered: 0, rate: 0 });
  });

  it('falls back to the stamp inside verification_id when ts is unusable', () => {
    const hook = hookRun({ session: 'S1', vid: 'v1-aaaaaaaaaaaa-20260914T120000Z', ts: 'not a date' });
    const self = selfReportRun({ session: 'S1', vid: 'v1-cccccccccccc-20260914T121000Z', ts: 'not a date' });

    const r = computeVerifyRate([...hook, ...self]);

    expect(r.firings).toEqual({ hook: 1, answered: 1, unordered: 0, rate: 1 });
  });

  it('counts an id with no usable ts AND an unknown stamp as unordered, never as answered', () => {
    const r = computeVerifyRate([
      ...hookRun({ session: 'S1', vid: 'v1-aaaaaaaaaaaa-unknown', ts: 'not a date' }),
      ...selfReportRun({ session: 'S1', vid: `v1-cccccccccccc-${STAMP}`, ts: '2026-09-14T12:10:00.000Z' }),
    ]);

    expect(r.ids.unknown_stamp).toBe(1);
    expect(r.firings).toEqual({ hook: 1, answered: 0, unordered: 1, rate: 0 });
    // The session-level answer survives: ordering is the only thing lost.
    expect(r.sessions.answered).toBe(1);
  });

  it('counts an unordered SELF-REPORT too, because it can answer no firing either', () => {
    // `unordered` is an OVERLAPPING diagnostic, not a subset of `firings.hook`:
    // it is "ids whose position in time this reader could not establish".
    // Reporting only the hook half would hide the other reason a rate reads low.
    const r = computeVerifyRate([
      ...hookRun({ session: 'S1', vid: `v1-aaaaaaaaaaaa-${STAMP}`, ts: '2026-09-14T12:00:00.000Z' }),
      ...selfReportRun({ session: 'S1', vid: 'v1-cccccccccccc-unknown', ts: 'not a date' }),
    ]);

    expect(r.firings).toEqual({ hook: 1, answered: 0, unordered: 1, rate: 0 });
    expect(r.ids.unknown_stamp).toBe(1);
  });
});

describe('verify-rate: denominators it refuses to invent', () => {
  it('reports a null rate rather than NaN when nothing fired', () => {
    const r = computeVerifyRate(
      selfReportRun({ session: 'S1', vid: `v1-cccccccccccc-${STAMP}`, ts: '2026-09-14T12:10:00.000Z' }),
    );

    expect(r.sessions).toEqual({ hook: 0, self_report: 1, answered: 0, rate: null });
    expect(r.firings).toEqual({ hook: 0, answered: 0, unordered: 0, rate: null });
  });

  it('puts a measured verification in `other`, never on either side', () => {
    // A line that is neither marked as a self-report nor `unmeasured` is a
    // future real measurement. Guessing it into `hook` would inflate the
    // denominator; guessing it into `self_report` would inflate the numerator.
    const ts = '2026-09-14T12:00:00.000Z';
    const vid = `v1-dddddddddddd-${STAMP}`;
    const r = computeVerifyRate([
      line({ session: 'S1', vid, layer: 'deterministic', result: 'pass', ts }),
      line({ session: 'S1', vid, layer: null, result: 'pass', ts }),
    ]);

    expect(r.ids).toEqual({ hook: 0, self_report: 0, other: 1, unknown_stamp: 0 });
    expect(r.sessions).toEqual({ hook: 0, self_report: 0, answered: 0, rate: null });
  });

  it('skips what is not a verify.completed line and counts the skip', () => {
    const r = computeVerifyRate([
      null,
      undefined,
      42,
      'a line',
      [],
      { event: 'tool.used', session_id: 'S1', ts: '2026-09-14T12:00:00.000Z', data: {} },
      ...hookRun({ session: 'S1', vid: `v1-aaaaaaaaaaaa-${STAMP}`, ts: '2026-09-14T12:00:00.000Z' }),
    ]);

    expect(r.lines).toEqual({ total: 10, verify_completed: 4, skipped: 6 });
    expect(r.ids.hook).toBe(1);
  });

  it('joins a line with no session_id to nothing, rather than pooling it', () => {
    // `lib/runtime/event-writer.js:444-445` refuses to WRITE such a line, but
    // `lib/runtime/ledger.js:270` checks only `event`, so a hand-written one
    // reaches this fold. Pooling every sessionless run under one empty key
    // would let two unrelated runs answer each other: the hook fire and the
    // self-report below have nothing to do with one another, and a rate of 1
    // here would be invented outright.
    const strip = (events) => events.map((e) => {
      const copy = { ...e };
      delete copy.session_id;
      return copy;
    });
    const r = computeVerifyRate([
      ...strip(hookRun({ session: 'x', vid: `v1-aaaaaaaaaaaa-${STAMP}`, ts: '2026-09-14T12:00:00.000Z' })),
      ...strip(selfReportRun({ session: 'x', vid: `v1-cccccccccccc-${STAMP}`, ts: '2026-09-14T12:10:00.000Z' })),
    ]);

    // Counted as runs — they exist and this reader saw them...
    expect(r.ids).toEqual({ hook: 1, self_report: 1, other: 0, unknown_stamp: 0 });
    // ...and joined to nothing, so they appear in neither rate.
    expect(r.sessions).toEqual({ hook: 0, self_report: 0, answered: 0, rate: null });
    expect(r.firings).toEqual({ hook: 0, answered: 0, unordered: 0, rate: null });
  });

  it('belongs a verify.completed line with no verification_id to no id at all', () => {
    // Stated because it is a silent gap, not a caught error: `verification_id`
    // is OPTIONAL in `schemas/ledger-events.allowlist.json:382` (only `result`
    // and `evidence` are required), so such a line is valid and unjoinable. It
    // is counted as a line and nowhere else.
    const ts = '2026-09-14T12:00:00.000Z';
    const orphan = line({ session: 'S1', vid: 'x', layer: 'deterministic', result: 'unmeasured', ts });
    delete orphan.data.verification_id;

    const r = computeVerifyRate([orphan]);

    expect(r.lines).toEqual({ total: 1, verify_completed: 1, skipped: 0 });
    expect(r.ids).toEqual({ hook: 0, self_report: 0, other: 0, unknown_stamp: 0 });
  });

  it('returns the zero shape for an empty, absent or non-array input', () => {
    const zero = {
      lines: { total: 0, verify_completed: 0, skipped: 0 },
      ids: { hook: 0, self_report: 0, other: 0, unknown_stamp: 0 },
      sessions: { hook: 0, self_report: 0, answered: 0, rate: null },
      firings: { hook: 0, answered: 0, unordered: 0, rate: null },
    };
    for (const input of [[], undefined, null, 'nope', 7, { length: 3 }]) {
      expect(computeVerifyRate(input)).toEqual(zero);
    }
  });

  it('does not mutate the events it was handed', () => {
    const events = briefFixture();
    const before = JSON.stringify(events);
    computeVerifyRate(events);
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe('verify-rate: the key set a caller can parse blind', () => {
  it('is fixed, in order, for every sub-object', () => {
    const r = computeVerifyRate(briefFixture());

    expect(Object.keys(r)).toEqual(['lines', 'ids', 'sessions', 'firings']);
    expect(Object.keys(r.lines)).toEqual(['total', 'verify_completed', 'skipped']);
    expect(Object.keys(r.ids)).toEqual(['hook', 'self_report', 'other', 'unknown_stamp']);
    expect(Object.keys(r.sessions)).toEqual(['hook', 'self_report', 'answered', 'rate']);
    expect(Object.keys(r.firings)).toEqual(['hook', 'answered', 'unordered', 'rate']);
  });

  it('keeps the key set when there is nothing to report', () => {
    const r = computeVerifyRate([]);
    expect(Object.keys(r.sessions)).toEqual(['hook', 'self_report', 'answered', 'rate']);
    expect(Object.keys(r.firings)).toEqual(['hook', 'answered', 'unordered', 'rate']);
  });
});

/**
 * Build a ledger the same order of magnitude as a real one, and count what it
 * contains WITHOUT using the module under test (rules §9: a fixture smaller
 * than the live data proves nothing about the live data, and an expectation
 * derived from the subject proves nothing at all).
 *
 * Session roles, by `i % 10`:
 *   0,1,2  hook, then a self-report AFTER it     -> answers the firing
 *   3      hook, with a self-report BEFORE it    -> answers the session only
 *   4      hook only, and its stamp is `unknown`
 *   5      a self-report and no hook at all
 *   6..9   hook only
 *
 * @param {number} sessionCount
 * @returns {{events: object[], expected: object}}
 */
function synthesize(sessionCount) {
  const events = [];
  const expected = {
    lines: { total: 0, verify_completed: 0, skipped: 0 },
    ids: { hook: 0, self_report: 0, other: 0, unknown_stamp: 0 },
    sessions: { hook: 0, self_report: 0, answered: 0, rate: null },
    firings: { hook: 0, answered: 0, unordered: 0, rate: null },
  };
  // Minutes added to an epoch, NOT written into the minutes field: a `% 60`
  // there wraps past session 40 and puts a session's self-report BEFORE its
  // own hook fire, which is how this oracle first disagreed with the module.
  const at = (m) => new Date(Date.UTC(2026, 8, 14) + m * 60_000).toISOString();

  for (let i = 0; i < sessionCount; i += 1) {
    const role = i % 10;
    const session = `S${i}`;
    const hex = String(i).padStart(12, '0');
    const hasHook = role !== 5;
    const hasSelf = role === 0 || role === 1 || role === 2 || role === 3 || role === 5;
    const selfFirst = role === 3;

    if (hasHook) {
      const stamp = role === 4 ? 'unknown' : STAMP;
      events.push(...hookRun({ session, vid: `v1-a${hex}-${stamp}`, ts: at(i + 10) }));
      expected.ids.hook += 1;
      expected.sessions.hook += 1;
      expected.firings.hook += 1;
      if (role === 4) expected.ids.unknown_stamp += 1;
    }
    if (hasSelf) {
      events.push(...selfReportRun({ session, vid: `v1-c${hex}-${STAMP}`, ts: at(i + (selfFirst ? 0 : 20)) }));
      expected.ids.self_report += 1;
      expected.sessions.self_report += 1;
      if (hasHook) expected.sessions.answered += 1;
      if (hasHook && !selfFirst) expected.firings.answered += 1;
    }
    // Four noise lines per verify line, so the verify lines are the minority
    // they are in a real ledger.
    const verifyLines = (hasHook ? 4 : 0) + (hasSelf ? 4 : 0);
    for (let n = 0; n < verifyLines * 4; n += 1) {
      seq += 1;
      events.push({
        ts: at(i), session_id: session, event: n % 2 === 0 ? 'tool.used' : 'mission.created',
        source: 'hook', pid: 1, seq, idempotency_key: `n${i}-${n}`, data: { tool: 'Read' },
      });
    }
    expected.lines.verify_completed += verifyLines;
    expected.lines.skipped += verifyLines * 4;
  }
  expected.lines.total = expected.lines.verify_completed + expected.lines.skipped;
  expected.sessions.rate = expected.sessions.answered / expected.sessions.hook;
  expected.firings.rate = expected.firings.answered / expected.firings.hook;
  return { events, expected };
}

describe('verify-rate: at the size of a real ledger', () => {
  it('counts 7,000 lines across 250 sessions exactly, and fast', () => {
    const { events, expected } = synthesize(250);

    // The generator is checked against hand-computed numbers before it is used
    // as an oracle: a generator that drifted would otherwise agree with a
    // reader that drifted the same way.
    expect(events).toHaveLength(7000);
    expect(expected.ids).toEqual({ hook: 225, self_report: 125, other: 0, unknown_stamp: 25 });
    expect(expected.firings.answered).toBe(75);
    expect(expected.sessions.answered).toBe(100);

    const started = Date.now();
    const r = computeVerifyRate(events);
    const elapsed = Date.now() - started;

    expect(r).toEqual(expected);
    // A ceiling, not a benchmark: it exists to catch an accidental O(n^2), and
    // the measured value is two orders of magnitude below it.
    expect(elapsed).toBeLessThan(2000);
  });
});
