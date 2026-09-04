/**
 * Unit contract for the ledger's Replay read model.
 *
 * ── WHAT THIS SUITE CANNOT SEE (repo rules §9) ──────────────────────────────
 *   - ZERO LIVE LEDGER LINES. Every fixture below was written by this file
 *     through `buildEnvelope`, the same assembler the writer uses. Phase 0
 *     ships with zero ledger writers wired in, so nothing here has ever been
 *     compared against a real run. What is verified is agreement with the
 *     ENVELOPE CONTRACT, not agreement with reality.
 *   - FIXTURE SCALE ≠ LIVE SCALE. The largest fixture here is on the order of
 *     tens of lines; a real ledger is bounded only by rotation. So these tests
 *     say nothing about behaviour at size: not the cost of `orderEvents`'s sort
 *     on a large stream, not memory when `includeEvents` holds references to a
 *     long history, and not `findSeqGaps` against a stream with a genuinely
 *     enormous hole. The range-not-enumeration choice in `findSeqGaps` is a
 *     defence against that case which THIS SUITE DOES NOT EXERCISE at scale —
 *     the one test below uses a gap of 96, which proves the shape and not the
 *     bound.
 *   - WHETHER AN ACTION GROUPING IS SEMANTICALLY RIGHT. `action_id` is optional
 *     in the envelope, so most groupings here are derived. The tests pin WHICH
 *     resolution was used (`keyed_by`), never that the resulting bucket matches
 *     what a human would call one action. That judgment has no source in Phase 0.
 *   - DETERMINISM ACROSS PROCESSES. The shuffle tests permute inside one V8
 *     instance. Object property order for integer-like keys, locale-dependent
 *     collation, and JSON number formatting are assumed stable and not measured
 *     across engines or platforms.
 *
 * @module tests/replay/replay
 */

import { describe, expect, it } from 'vitest';
import { buildEnvelope } from '../../lib/runtime/event-writer.js';
import {
  actionKeyOf,
  ATTRIBUTION,
  buildReplay,
  compareEvents,
  countBy,
  dedupeKey,
  envelopeFaults,
  findSeqGaps,
  foldByAction,
  GAP_TYPES,
  orderEvents,
  serializeIndex,
} from '../../lib/replay/index.js';

const SID = 'sess-replay-0001';
const MISSION = 'M-20260902-041';
const OTHER_MISSION = 'M-20260902-042';

/**
 * Build one well-formed ledger line with fully controlled ordering terms.
 *
 * `ts`, `pid` and `seq` are always explicit: a fixture that leans on the real
 * clock or the real pid cannot make a claim about ordering, because the values
 * it sorts on change between runs.
 *
 * @param {object} fields - envelope fields; `event` at minimum.
 * @param {{ts?: string, pid?: number, seq?: number}} [ord] - ordering terms.
 * @returns {object} envelope.
 */
function line(fields, ord = {}) {
  const ts = ord.ts ?? '2026-09-02T10:00:00.000Z';
  return buildEnvelope(
    { session_id: SID, source: 'hook', mission_id: MISSION, ts, ...fields },
    { pid: ord.pid ?? 100, seq: ord.seq ?? 0 },
  );
}

/**
 * A small but complete stream: two actions in one mission, one route receipt,
 * one usage receipt, no switches (the Observe expectation).
 *
 * @returns {object[]} ledger lines in emission order.
 */
function seed() {
  return [
    line({ event: 'mission.created', data: { title: 'T', intent_revision: 1 } },
      { ts: '2026-09-02T10:00:00.000Z', seq: 0 }),
    line({
      event: 'route.selected',
      source: 'scheduler',
      action_id: 'act-1',
      routing_epoch_id: 'ep-1',
      data: { route_receipt_id: 'rr-1', decision: { type: 'route' } },
    }, { ts: '2026-09-02T10:00:01.000Z', seq: 1 }),
    line({
      event: 'tool.used',
      action_id: 'act-1',
      data: { tool: 'Bash', ok: true, duration_ms: 3 },
    }, { ts: '2026-09-02T10:00:02.000Z', seq: 2 }),
    line({
      event: 'usage.receipt',
      source: 'worker',
      action_id: 'act-2',
      model: 'claude-opus-5',
      data: { run_id: 'run-1', cost: { total: 0.5 } },
    }, { ts: '2026-09-02T10:00:03.000Z', seq: 3 }),
    line({
      event: 'tool.used',
      action_id: 'act-2',
      data: { tool: 'Read', ok: true, duration_ms: 1 },
    }, { ts: '2026-09-02T10:00:04.000Z', seq: 4 }),
  ];
}

/**
 * A deterministic permutation — no randomness, so a failure reproduces.
 *
 * @param {object[]} arr - input.
 * @returns {object[]} reordered copy.
 */
function shuffled(arr) {
  const out = [...arr];
  out.reverse();
  const mid = Math.floor(out.length / 2);
  return [...out.slice(mid), ...out.slice(0, mid)];
}

// ---------------------------------------------------------------------------

describe('envelope screening', () => {
  it('accepts a line the writer would have written', () => {
    expect(envelopeFaults(line({ event: 'tool.used' }))).toEqual([]);
  });

  it('names every missing required key rather than the first one', () => {
    // Reporting only the first fault makes a caller fix one thing at a time and
    // re-run; the ledger has eight required keys and a torn line often loses
    // several.
    const faults = envelopeFaults({ event: 'tool.used' });
    expect(faults).toEqual(['v', 'ts', 'mission_id', 'session_id', 'source', 'pid', 'seq']);
  });

  it('rejects a present-but-wrong-typed ordering term', () => {
    // `seq: '7'` is present. It is also unusable as a sort term, and admitting
    // it would place a broken line into the index instead of into gaps[].
    expect(envelopeFaults(line({ event: 'tool.used' }, { seq: 7 }))).toEqual([]);
    expect(envelopeFaults({ ...line({ event: 'tool.used' }), seq: '7' })).toEqual(['seq']);
    expect(envelopeFaults({ ...line({ event: 'tool.used' }), pid: 1.5 })).toEqual(['pid']);
  });

  it('rejects an unparseable timestamp (it has no position in the order)', () => {
    expect(envelopeFaults({ ...line({ event: 'tool.used' }), ts: 'yesterday' })).toEqual(['ts']);
  });

  it('rejects non-objects without throwing', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(envelopeFaults(bad)).toEqual(['(not an object)']);
    }
  });
});

describe('deterministic order', () => {
  it('orders by (ts, source, pid, seq)', () => {
    const a = line({ event: 'tool.used' }, { ts: '2026-09-02T10:00:00.000Z', seq: 5 });
    const b = line({ event: 'tool.used' }, { ts: '2026-09-02T10:00:01.000Z', seq: 1 });
    expect(compareEvents(a, b)).toBeLessThan(0);
    const c = line({ event: 'tool.used', source: 'gate' }, { seq: 1 });
    const d = line({ event: 'tool.used', source: 'worker' }, { seq: 0 });
    expect(compareEvents(c, d)).toBeLessThan(0);
    const e = line({ event: 'tool.used' }, { pid: 9, seq: 99 });
    const f = line({ event: 'tool.used' }, { pid: 10, seq: 0 });
    expect(compareEvents(e, f)).toBeLessThan(0);
  });

  it('sorts pid numerically, not lexicographically', () => {
    // '9' > '10' as strings. A string comparison here would interleave two
    // processes' streams and silently reorder the history.
    const nine = line({ event: 'tool.used' }, { pid: 9, seq: 0 });
    const ten = line({ event: 'tool.used' }, { pid: 10, seq: 0 });
    expect(compareEvents(nine, ten)).toBeLessThan(0);
  });

  it('a shuffled input yields a byte-identical index', () => {
    const events = seed();
    const straight = serializeIndex(buildReplay(events));
    for (let i = 0; i < 4; i += 1) {
      expect(serializeIndex(buildReplay(shuffled(events)))).toBe(straight);
    }
  });

  it('the same input built twice is byte-identical', () => {
    const events = seed();
    expect(serializeIndex(buildReplay(events))).toBe(serializeIndex(buildReplay(events)));
  });

  it('event histograms are key-sorted so property order cannot vary', () => {
    // Built in encounter order, a histogram serializes differently for a
    // shuffled input even when the counts agree.
    const events = [
      line({ event: 'verify.completed', source: 'gate', data: { result: 'pass', evidence: [] } },
        { seq: 0 }),
      line({ event: 'mission.created', data: { title: 'T', intent_revision: 1 } }, { seq: 1 }),
      line({ event: 'tool.used', data: { tool: 'Bash', ok: true, duration_ms: 1 } }, { seq: 2 }),
    ];
    const index = buildReplay(events);
    expect(Object.keys(index.totals.events)).toEqual(
      ['mission.created', 'tool.used', 'verify.completed'],
    );
  });
});

describe('gaps are enumerated, never hidden', () => {
  it('a malformed line goes to gaps and not into the index', () => {
    const events = [...seed(), { event: 'tool.used', seq: 'x' }];
    const index = buildReplay(events);
    expect(index.totals.received).toBe(6);
    expect(index.totals.indexed).toBe(5);
    const envelopeGaps = index.gaps.filter((g) => g.type === GAP_TYPES.ENVELOPE);
    expect(envelopeGaps).toHaveLength(1);
    expect(envelopeGaps[0].index).toBe(5);
    expect(envelopeGaps[0].missing).toContain('seq');
  });

  it('a ledger.rejected line is recorded as a gap, not folded into an action', () => {
    const events = [
      ...seed(),
      line({
        event: 'ledger.rejected',
        data: { raw_event: 'bogus.name', reason: 'unregistered-event' },
      }, { ts: '2026-09-02T10:00:05.000Z', seq: 5 }),
    ];
    const index = buildReplay(events);
    const rejected = index.gaps.filter((g) => g.type === GAP_TYPES.REJECTED);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('unregistered-event');
    expect(index.totals.events['ledger.rejected']).toBeUndefined();
  });

  it('a duplicate is collapsed on (source, pid, seq) AND reported', () => {
    // Collapsing silently would make a double-written line indistinguishable
    // from a single one, which is the thing the reader-side dedupe exists to
    // make visible.
    const events = seed();
    const index = buildReplay([...events, { ...events[2] }]);
    expect(index.totals.indexed).toBe(5);
    const dupes = index.gaps.filter((g) => g.type === GAP_TYPES.DUPLICATE);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toMatchObject({ source: 'hook', pid: 100, seq: 2, event: 'tool.used' });
  });

  it('reports a seq hole as a range, per (source, pid) stream', () => {
    const events = [
      line({ event: 'tool.used', data: {} }, { seq: 1 }),
      line({ event: 'tool.used', data: {} }, { seq: 98 }),
    ];
    const { ordered } = orderEvents(events);
    expect(findSeqGaps(ordered)).toEqual([
      { type: GAP_TYPES.SEQ, session_id: SID, pid: 100, from: 2, to: 97, count: 96 },
    ]);
  });

  it('does not invent a gap when two sessions share a pid', () => {
    // PID IS REUSED — the OS recycles process ids and the ledger outlives any
    // one process. Grouping by pid alone merges two unrelated processes into
    // one stream, so session B's 0..2 appears to interleave with session A's
    // 0..2 and the union 0,0,1,1,2,2 reads as one damaged stream. Each session
    // numbered contiguously from 0, so the correct answer is zero gaps.
    const other = 'sess-replay-0002';
    const events = [];
    for (const sid of [SID, other]) {
      for (let seq = 0; seq <= 2; seq += 1) {
        events.push(line({ event: 'tool.used', session_id: sid }, { pid: 100, seq }));
      }
    }
    expect(findSeqGaps(orderEvents(events).ordered)).toEqual([]);
  });

  it('still finds a real hole inside one session when a pid is shared', () => {
    // The companion to the test above: suppressing the false positive must not
    // suppress the true one. Session A loses seq 1; session B is intact.
    const other = 'sess-replay-0002';
    const events = [
      line({ event: 'tool.used' }, { pid: 100, seq: 0 }),
      line({ event: 'tool.used' }, { pid: 100, seq: 2 }),
      line({ event: 'tool.used', session_id: other }, { pid: 100, seq: 0 }),
      line({ event: 'tool.used', session_id: other }, { pid: 100, seq: 1 }),
    ];
    expect(findSeqGaps(orderEvents(events).ordered)).toEqual([
      { type: GAP_TYPES.SEQ, session_id: SID, pid: 100, from: 1, to: 1, count: 1 },
    ]);
  });

  it('two sessions sharing a pid and a seq are two lines, not a duplicate', () => {
    // The dedupe half of the same hazard: on a (source, pid, seq) key these two
    // collide and one is dropped as a duplicate. A dropped distinct line is
    // data loss that looks like successful dedupe.
    const other = 'sess-replay-0002';
    const events = [
      line({ event: 'tool.used' }, { pid: 100, seq: 0 }),
      line({ event: 'tool.used', session_id: other }, { pid: 100, seq: 0 }),
    ];
    const index = buildReplay(events);
    expect(index.totals.indexed).toBe(2);
    expect(index.gaps).toEqual([]);
  });

  it('does not invent a gap when one process emits under several sources', () => {
    // REGRESSION (found 2026-09-02 by 'a clean stream reports no gaps' below).
    // `seq` is a PER-PROCESS counter (event-writer.js#nextSeq: "never
    // coordinated across processes"), and one process writes as `hook`,
    // `scheduler`, `worker` and so on. An earlier draft grouped streams by
    // (source, pid) and so reported a hole in every ordinary multi-source
    // process — a fabricated finding, which is the one thing a gap report must
    // never produce.
    const events = [
      line({ event: 'tool.used' }, { seq: 0 }),
      line({ event: 'route.selected', source: 'scheduler' }, { seq: 1 }),
      line({ event: 'usage.receipt', source: 'worker', model: 'claude-opus-5' }, { seq: 2 }),
      line({ event: 'tool.used' }, { seq: 3 }),
    ];
    expect(findSeqGaps(orderEvents(events).ordered)).toEqual([]);
  });

  it('does not invent a gap across two different processes', () => {
    // seq is per-process. Comparing across pids would report a hole in every
    // multi-process run, which is a fabricated finding.
    const events = [
      line({ event: 'tool.used' }, { pid: 100, seq: 0 }),
      line({ event: 'tool.used' }, { pid: 200, seq: 50 }),
    ];
    const { ordered } = orderEvents(events);
    expect(findSeqGaps(ordered)).toEqual([]);
  });

  it('does not invent a gap at the edges of a stream', () => {
    // Nothing in the data says a stream should have started at 0, so a stream
    // observed as [7, 8] has no reportable hole.
    const events = [
      line({ event: 'tool.used' }, { seq: 7 }),
      line({ event: 'tool.used' }, { seq: 8 }),
    ];
    expect(findSeqGaps(orderEvents(events).ordered)).toEqual([]);
  });

  it('a clean stream reports no gaps', () => {
    expect(buildReplay(seed()).gaps).toEqual([]);
  });
});

describe('action attribution', () => {
  it('prefers action_id, then routing_epoch_id, then session_id', () => {
    expect(actionKeyOf(line({ event: 'tool.used', action_id: 'a', routing_epoch_id: 'e' })))
      .toMatchObject({ keyed_by: 'action_id' });
    expect(actionKeyOf(line({ event: 'tool.used', routing_epoch_id: 'e' })))
      .toMatchObject({ keyed_by: 'routing_epoch_id' });
    expect(actionKeyOf(line({ event: 'tool.used' })))
      .toMatchObject({ keyed_by: 'session_id' });
  });

  it('keeps two missions apart even when they share an epoch id', () => {
    const a = actionKeyOf(line({ event: 'tool.used', routing_epoch_id: 'ep' }));
    const b = actionKeyOf(line({
      event: 'tool.used', mission_id: OTHER_MISSION, routing_epoch_id: 'ep',
    }));
    expect(a.key).not.toBe(b.key);
  });

  it('groups by action and records the resolution used for each', () => {
    const index = buildReplay(seed());
    expect(index.actions.map((a) => a.action_id)).toEqual([null, 'act-1', 'act-2']);
    expect(index.actions.map((a) => a.keyed_by)).toEqual(
      ['session_id', 'action_id', 'action_id'],
    );
    expect(index.attribution).toEqual({ action_id: 2, routing_epoch_id: 0, session_id: 1 });
    expect(Object.keys(index.attribution)).toEqual([...ATTRIBUTION]);
  });

  it('carries the action time span and event histogram', () => {
    const act1 = buildReplay(seed()).actions.find((a) => a.action_id === 'act-1');
    expect(act1.first_ts).toBe('2026-09-02T10:00:01.000Z');
    expect(act1.last_ts).toBe('2026-09-02T10:00:02.000Z');
    expect(act1.event_counts).toEqual({ 'route.selected': 1, 'tool.used': 1 });
    expect(act1.routing_epoch_id).toBe('ep-1');
  });

  it('holds references to the caller events, not copies', () => {
    // A clone is a second copy of the history in memory and drifts the moment
    // either side is touched.
    const events = seed();
    const index = buildReplay(events);
    const act1 = index.actions.find((a) => a.action_id === 'act-1');
    expect(act1.events[0]).toBe(events[1]);
  });

  it('includeEvents:false drops the member lines but keeps the counts', () => {
    const actions = foldByAction(orderEvents(seed()).ordered, { includeEvents: false });
    expect(actions.every((a) => a.events.length === 0)).toBe(true);
    expect(actions.find((a) => a.action_id === 'act-2').event_counts)
      .toEqual({ 'tool.used': 1, 'usage.receipt': 1 });
  });
});

describe('mission index', () => {
  it('lists a mission\'s actions, sessions and span without re-answering foldMissions', () => {
    const index = buildReplay(seed());
    expect(index.missions).toHaveLength(1);
    const m = index.missions[0];
    expect(m.mission_id).toBe(MISSION);
    expect(m.action_keys).toHaveLength(3);
    expect(m.sessions).toEqual([SID]);
    expect(m.first_ts).toBe('2026-09-02T10:00:00.000Z');
    expect(m.last_ts).toBe('2026-09-02T10:00:04.000Z');
    // Deliberately absent: the v1.0 run-ledger fields. Two modules maintaining
    // separate arithmetic for one question is how the two answers drift.
    for (const field of ['economics', 'route', 'review', 'verification', 'outcome']) {
      expect(m[field]).toBeUndefined();
    }
  });

  it('separates two missions in one stream', () => {
    const events = [
      ...seed(),
      line({ event: 'tool.used', mission_id: OTHER_MISSION }, { seq: 9 }),
    ];
    expect(buildReplay(events).missions.map((m) => m.mission_id))
      .toEqual([MISSION, OTHER_MISSION]);
  });
});

describe('projections', () => {
  it('routes[] carries the route.selected receipts', () => {
    const index = buildReplay(seed());
    expect(index.routes).toHaveLength(1);
    expect(index.routes[0].data.route_receipt_id).toBe('rr-1');
  });

  it('usage[] carries the usage.receipt lines', () => {
    expect(buildReplay(seed()).usage).toHaveLength(1);
  });

  it('switches[] is empty in an Observe-shaped stream', () => {
    // Design §8.4 puts model switching behind Shadow. A non-empty array here in
    // Phase 0 is a finding, so it is a first-class field rather than something
    // a consumer has to go looking for.
    expect(buildReplay(seed()).switches).toEqual([]);
  });

  it('switches[] still surfaces a model.switched line if one appears', () => {
    const events = [...seed(), line({
      event: 'model.switched',
      source: 'scheduler',
      data: { from: 'claude-sonnet-5', to: 'claude-opus-5', reason: 'escalate' },
    }, { ts: '2026-09-02T10:00:06.000Z', seq: 6 })];
    expect(buildReplay(events).switches).toHaveLength(1);
  });

  it('every field is present on an empty input, so no consumer branches on undefined', () => {
    const index = buildReplay([]);
    expect(index).toMatchObject({
      missions: [], actions: [], routes: [], switches: [], usage: [], context: [], gaps: [],
    });
    // `census: null` = NOT COUNTED. buildReplay is pure and has no file to
    // count; `loadReplay` fills the slot from the `readLedger` port (F-30).
    expect(index.totals).toEqual({ received: 0, indexed: 0, events: {}, census: null });
    expect(index.attribution).toEqual({ action_id: 0, routing_epoch_id: 0, session_id: 0 });
  });

  it('tolerates a non-array input rather than throwing', () => {
    for (const bad of [null, undefined, 'x', 7]) {
      expect(buildReplay(bad).totals.received).toBe(0);
    }
  });
});

describe('countBy carries its denominator', () => {
  it('counts a field and reports total and absent', () => {
    const events = seed();
    expect(countBy(events, 'event')).toEqual({
      counts: {
        'mission.created': 1, 'route.selected': 1, 'tool.used': 2, 'usage.receipt': 1,
      },
      absent: 0,
      total: 5,
    });
  });

  it('counts lines with no value under absent, never a synthetic bucket', () => {
    // A synthetic "(missing)" label can collide with a real value. `absent` is
    // a separate number and cannot.
    const result = countBy(seed(), 'action_id');
    expect(result).toEqual({ counts: { 'act-1': 2, 'act-2': 2 }, absent: 1, total: 5 });
  });

  it('accepts a selector for values that are not top-level fields', () => {
    expect(countBy(seed(), (e) => e.data?.tool)).toEqual({
      counts: { Bash: 1, Read: 1 }, absent: 3, total: 5,
    });
  });

  it('key-sorts counts so the same input serializes identically', () => {
    const events = [
      line({ event: 'tool.used', data: { tool: 'Write' } }, { seq: 0 }),
      line({ event: 'tool.used', data: { tool: 'Bash' } }, { seq: 1 }),
      line({ event: 'tool.used', data: { tool: 'Read' } }, { seq: 2 }),
    ];
    expect(Object.keys(countBy(events, (e) => e.data.tool).counts))
      .toEqual(['Bash', 'Read', 'Write']);
  });

  it('total is the denominator of the whole input, not of the counted subset', () => {
    // Without this, a rate computed from `counts` alone silently uses the wrong
    // denominator whenever some lines lack the field.
    const r = countBy(seed(), 'action_id');
    expect(r.total).toBe(5);
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0) + r.absent).toBe(r.total);
  });

  it('tolerates a non-array input', () => {
    expect(countBy(null, 'event')).toEqual({ counts: {}, absent: 0, total: 0 });
  });
});

describe('dedupeKey', () => {
  it('is the (session_id, source, pid, seq) tuple', () => {
    // `event` is NOT part of the identity: two different events cannot share
    // one seq from one process, so a collision here means a writer bug.
    const a = line({ event: 'tool.used' }, { pid: 3, seq: 4 });
    const b = line({ event: 'review.requested' }, { pid: 3, seq: 4 });
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it('separates two sessions that share a pid and a seq', () => {
    // Without the session term these collide and one line is dropped as a
    // duplicate — data loss wearing the costume of successful dedupe.
    const a = line({ event: 'tool.used' }, { pid: 3, seq: 4 });
    const b = line({ event: 'tool.used', session_id: 'sess-replay-0002' }, { pid: 3, seq: 4 });
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  });

  it('does not confuse adjacent field boundaries', () => {
    // A naive concatenation makes ('a', 1, 23) and ('a', 12, 3) the same key.
    const a = line({ event: 'tool.used' }, { pid: 1, seq: 23 });
    const b = line({ event: 'tool.used' }, { pid: 12, seq: 3 });
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  });

  it('joins on NUL, which a session id cannot smuggle past the screen', () => {
    // `session_id` is an opaque host string. With a PRINTABLE separator a
    // crafted id could forge another line's key and get that line dropped as a
    // duplicate — so the separator choice is load-bearing, not cosmetic. NUL is
    // also what ledger.js#dedupeEvents joins with; pinning it here keeps the
    // two key shapes from drifting apart on the separator alone.
    const key = dedupeKey(line({ event: 'tool.used' }, { pid: 1, seq: 0 }));
    expect(key.split('\0')).toEqual([SID, 'hook', '1', '0']);
  });

  it('a session id carrying the separator still cannot collide', () => {
    // Even granting a session id containing NUL (JSON can encode \0),
    // forging fails: `pid` and `seq` are screened as integers, so the crafted
    // string would have to land a non-integer in an integer position.
    const a = line({ event: 'tool.used', session_id: 'x\0hook' }, { pid: 1, seq: 0 });
    const b = line({ event: 'tool.used', session_id: 'x' }, { pid: 1, seq: 0 });
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  });
});

describe('serializeIndex', () => {
  it('returns a string and parses back to the same index', () => {
    const index = buildReplay(seed());
    const text = serializeIndex(index);
    expect(typeof text).toBe('string');
    expect(JSON.parse(text).totals.indexed).toBe(5);
  });

  it('honours an indent without changing the content', () => {
    const index = buildReplay(seed());
    const pretty = serializeIndex(index, { indent: 2 });
    expect(pretty).toContain('\n');
    expect(JSON.parse(pretty)).toEqual(JSON.parse(serializeIndex(index)));
  });
});
