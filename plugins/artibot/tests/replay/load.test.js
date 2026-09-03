/**
 * Contract for `loadReplay` — the injected-port boundary between L2 replay and
 * the L5 ledger reader.
 *
 * ── WHAT THIS SUITE CANNOT SEE (repo rules §9) ──────────────────────────────
 *   - ZERO LIVE LEDGER LINES. The integration test below writes its own ledger
 *     through `appendLedgerEvent` into a temp directory. That proves the port
 *     signature matches the real `readAllEvents` and that a real file round-
 *     trips; it proves nothing about a ledger produced by an actual run,
 *     because Phase 0 has no wired writers.
 *   - FIXTURE SCALE ≠ LIVE SCALE. Three lines on disk. Nothing here says how
 *     `readAllEvents` + `buildReplay` behave on a rotated, multi-process ledger.
 *   - THE LAYER RULE ITSELF. This suite checks that the port EXISTS and is
 *     required. Whether `lib/replay` actually stays free of an
 *     `import ... from '../runtime/...'` is enforced by eslint's L2 block and
 *     is asserted separately in `no-second-source.test.js`.
 *
 * @module tests/replay/load
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetSeq } from '../../lib/runtime/event-writer.js';
import { appendLedgerEvent, ledgerFilePath, readAllEvents } from '../../lib/runtime/ledger.js';
import { loadReplay } from '../../lib/replay/index.js';

const SID = 'sess-replay-load-01';
const MISSION = 'M-20260902-043';

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-replay-'));
  resetSeq();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the reader is an injected port', () => {
  it('throws when no port is supplied', () => {
    // Fail-closed. Defaulting to [] would let a miswired caller receive a
    // well-formed index describing a run in which nothing happened, making
    // "no events" and "never asked" the same output.
    expect(() => loadReplay(root)).toThrow(TypeError);
    expect(() => loadReplay(root)).toThrow(/readEvents/);
  });

  it('throws when the port is not callable', () => {
    expect(() => loadReplay(root, { readEvents: 'readAllEvents' })).toThrow(TypeError);
  });

  it('names the layer rule in the error, so the fix is obvious', () => {
    // The next person hitting this needs to know the import is forbidden, not
    // merely that an argument is missing.
    expect(() => loadReplay(root)).toThrow(/L2 and cannot import lib\/runtime \(L5\)/);
  });

  it('passes projectRoot and filter through to the port verbatim', () => {
    // This module adds no filtering vocabulary of its own, so it cannot drift
    // from the reader's.
    const calls = [];
    const port = (r, f) => {
      calls.push([r, f]);
      return [];
    };
    const filter = { mission_id: MISSION, since: '2026-09-02T00:00:00.000Z' };
    loadReplay('/some/root', { readEvents: port, filter });
    expect(calls).toEqual([['/some/root', filter]]);
  });

  it('defaults the filter to an empty object rather than undefined', () => {
    let seen;
    loadReplay(root, { readEvents: (_r, f) => { seen = f; return []; } });
    expect(seen).toEqual({});
  });

  it('tolerates a port that returns a non-array', () => {
    for (const bad of [null, undefined, 'x']) {
      expect(loadReplay(root, { readEvents: () => bad }).totals.received).toBe(0);
    }
  });

  it('forwards includeEvents to buildReplay', () => {
    const events = [{
      v: 1,
      ts: '2026-09-02T10:00:00.000Z',
      event: 'tool.used',
      mission_id: MISSION,
      session_id: SID,
      source: 'hook',
      pid: 1,
      seq: 0,
    }];
    const lean = loadReplay(root, { readEvents: () => events, includeEvents: false });
    expect(lean.actions[0].events).toEqual([]);
    const full = loadReplay(root, { readEvents: () => events });
    expect(full.actions[0].events).toHaveLength(1);
  });
});

describe('integration with the real ledger reader', () => {
  it('indexes a ledger written through appendLedgerEvent', () => {
    // The point of this test is the SIGNATURE: `readAllEvents` really is
    // `(root, filter) => object[]`, so the port contract is not a guess.
    appendLedgerEvent(root, {
      event: 'mission.created',
      session_id: SID,
      source: 'hook',
      mission_id: MISSION,
      data: { title: 'T', intent_revision: 1 },
    });
    appendLedgerEvent(root, {
      event: 'tool.used',
      session_id: SID,
      source: 'hook',
      mission_id: MISSION,
      action_id: 'act-9',
      data: { tool: 'Bash', ok: true, duration_ms: 2 },
    });

    const index = loadReplay(root, { readEvents: readAllEvents });

    expect(index.totals.indexed).toBe(2);
    expect(index.missions.map((m) => m.mission_id)).toEqual([MISSION]);
    expect(index.actions.map((a) => a.keyed_by)).toEqual(['session_id', 'action_id']);
    expect(index.gaps).toEqual([]);
  });

  it('totals.received counts SURVIVORS, not the ledger\'s lines', () => {
    // The misreading this field's name exists to prevent: an operator seeing
    // `received === indexed` and concluding nothing was lost.
    //
    // Three lines reach the FILE; one is corrupt. `readAllEvents` discards it
    // with no counter, so replay is handed two and indexes two. The index is
    // internally consistent and `gaps[]` is empty — yet a line WAS lost, and
    // nothing in this object can show it. That is the whole point: loss above
    // the reader is not observable here, so the field must not be named as
    // though it were the input to the pipeline.
    for (const seq of [0, 1]) {
      appendLedgerEvent(root, {
        event: 'tool.used',
        session_id: SID,
        source: 'hook',
        mission_id: MISSION,
        data: { tool: 'Bash', ok: true, duration_ms: seq },
      });
    }
    appendFileSync(ledgerFilePath(root), '{"v":1,"ts":"broken\n', 'utf-8');

    const rawLines = readFileSync(ledgerFilePath(root), 'utf-8')
      .split('\n').filter((l) => l.trim().length > 0).length;
    const index = loadReplay(root, { readEvents: readAllEvents });

    expect(rawLines).toBe(3);
    expect(index.totals.received).toBe(2);
    expect(index.totals.indexed).toBe(2);
    // Internally consistent and clean-looking, despite the lost line.
    expect(index.gaps).toEqual([]);
    expect(index.totals.received).toBeLessThan(rawLines);
  });

  it('returns an empty index for a project with no ledger file', () => {
    const index = loadReplay(root, { readEvents: readAllEvents });
    expect(index.totals).toEqual({ received: 0, indexed: 0, events: {} });
    expect(index.missions).toEqual([]);
  });

  it('honours the reader\'s mission filter', () => {
    for (const mission of [MISSION, 'M-20260902-044']) {
      appendLedgerEvent(root, {
        event: 'tool.used',
        session_id: SID,
        source: 'hook',
        mission_id: mission,
        data: { tool: 'Bash', ok: true, duration_ms: 1 },
      });
    }
    const index = loadReplay(root, {
      readEvents: readAllEvents,
      filter: { mission_id: MISSION },
    });
    expect(index.missions.map((m) => m.mission_id)).toEqual([MISSION]);
  });

  it('surfaces a ledger.rejected line as a gap when the reader includes them', () => {
    // The writer rejects an unregistered event name and records that rejection.
    // Replay must show it rather than present a clean index over a lossy file.
    appendLedgerEvent(root, {
      event: 'not.registered',
      session_id: SID,
      source: 'hook',
      mission_id: MISSION,
      data: {},
    });
    const index = loadReplay(root, {
      readEvents: readAllEvents,
      filter: { includeRejected: true },
    });
    expect(index.gaps.filter((g) => g.type === 'rejected')).toHaveLength(1);
    expect(index.totals.indexed).toBe(0);
  });
});
