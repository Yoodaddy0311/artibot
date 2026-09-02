/**
 * Replay the one real-operator `/split` run on record
 * (`reports/SPLIT/split-8f83d7.events.ndjson`, 2026-08-27, n=1) through the
 * reducer and the run store.
 *
 * The file is `-text` in `.gitattributes` (byte-immutable evidence); it is
 * read as bytes and copied verbatim into a temp store dir so the real
 * `reports/` tree is never written to.
 *
 * What this proves: the mapping in `state-reducer.js` lands the only live
 * stream we have on `COMPLETED` with zero warnings, and the store rebuilds
 * it byte-identically. What it does not prove: anything about a run with
 * lanes, heartbeats, or a failure — no such live stream exists.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reduce } from '../../lib/supervisor/state-reducer.js';
import { validateRunState } from '../../lib/supervisor/contracts.js';
import { parseNdjson, readAllEvents, rebuildState } from '../../lib/supervisor/run-store.js';
import { summarizeWallClock } from '../../lib/observability/split-telemetry.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.resolve(PLUGIN_ROOT, '..', '..', 'reports', 'SPLIT', 'split-8f83d7.events.ndjson');
const RUN = 'split-8f83d7';
const present = existsSync(FIXTURE);

/** @type {string} */ let storeDir = '';
beforeEach(() => {
  storeDir = mkdtempSync(path.join(os.tmpdir(), 'supervisor-replay-'));
});
afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

describe.skipIf(!present)('live fixture split-8f83d7', () => {
  it('is read as bytes: LF only, 15 lines, every line parses', () => {
    const raw = readFileSync(FIXTURE);
    expect(raw.includes(0x0d)).toBe(false);
    const events = parseNdjson(raw.toString('utf-8'));
    expect(events).toHaveLength(15);
    expect(raw.toString('utf-8').split('\n').filter(Boolean)).toHaveLength(15);
  });

  it('reduces to COMPLETED with zero warnings and schema-valid state', () => {
    const events = parseNdjson(readFileSync(FIXTURE).toString('utf-8'));
    const { state, warnings } = reduce(events);
    expect(warnings).toEqual([]);
    expect(state).toMatchObject({
      version: 1,
      runId: RUN,
      state: 'COMPLETED',
      createdAt: '2026-08-27T10:16:16.663Z',
      updatedAt: '2026-08-27T13:23:39.372Z',
      base: null,
      lanes: {},
      exceptionCount: 0,
    });
    expect(validateRunState(state).ok).toBe(true);
    // Intermediate states along the stream, as the design phases fire.
    const at = (n) => reduce(events.slice(0, n)).state.state;
    expect(at(1)).toBe('CREATED');
    expect(at(2)).toBe('PLANNED');
    expect(at(6)).toBe('PROVISIONING');
    expect(at(9)).toBe('READY');
    expect(at(10)).toBe('READY'); // dispatch was refused — not execution
    expect(at(13)).toBe('INTEGRATING');
    expect(at(14)).toBe('COMPLETED');
  });

  it('store rebuild is byte-stable across a cache delete and leaves the fixture copy untouched', () => {
    const copy = path.join(storeDir, `${RUN}.events.ndjson`);
    copyFileSync(FIXTURE, copy);
    const before = readFileSync(copy);
    const a = rebuildState(RUN, { storeDir });
    const bytesA = readFileSync(a.path);
    unlinkSync(a.path);
    const b = rebuildState(RUN, { storeDir });
    expect(readFileSync(b.path).equals(bytesA)).toBe(true);
    expect(b.state.state).toBe('COMPLETED');
    expect(b.events).toBe(15);
    expect(readFileSync(copy).equals(before)).toBe(true);
    // The wall-clock summary the dashboard prints, on the same merged stream.
    const wall = summarizeWallClock(readAllEvents(RUN, { storeDir }));
    expect(wall.totalMs).toBe(11242709);
    expect(wall.humanWaitPct).not.toBe(null);
    expect(wall.unpaired).toEqual([]);
  });
});
