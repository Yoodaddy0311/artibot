/**
 * `lib/supervisor/run-store` — PR-SV02 append / idempotency / rebuild.
 *
 * Every path goes through a `storeDir` under `os.tmpdir()`; the real
 * `runtime/split/` is never touched. The telemetry file is written with the
 * real recorder (`split-telemetry.js`) so the merge is exercised against the
 * real line shape, and its bytes are compared before/after to prove the
 * store never writes into it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendEvent,
  getStatePath,
  getSupervisorEventsPath,
  normalizeEnvelope,
  parseNdjson,
  readAllEvents,
  readState,
  readSupervisorEvents,
  rebuildState,
} from '../../lib/supervisor/run-store.js';
import { getSplitEventsPath, recordPhaseEnd, recordPhaseStart } from '../../lib/observability/split-telemetry.js';

const RUN = 'split-store-test';
/** @type {string} */ let storeDir = '';

beforeEach(() => {
  storeDir = mkdtempSync(path.join(os.tmpdir(), 'supervisor-store-'));
});
afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

describe('paths and parsing', () => {
  it('supervisor file is separate from the telemetry file', () => {
    const sup = getSupervisorEventsPath(RUN, { storeDir });
    const tel = getSplitEventsPath(RUN, { storeDir });
    expect(path.dirname(sup)).toBe(path.dirname(tel));
    expect(sup).not.toBe(tel);
    expect(sup.endsWith('.supervisor.ndjson')).toBe(true);
    expect(getStatePath(RUN, { storeDir }).endsWith('.state.json')).toBe(true);
    expect(() => getStatePath('', { storeDir })).toThrow(TypeError);
  });

  it('parseNdjson skips blank and torn lines', () => {
    expect(parseNdjson('{"a":1}\n\n{"b":2\n{"c":3}\n')).toEqual([{ a: 1 }, { c: 3 }]);
    expect(parseNdjson('')).toEqual([]);
    expect(parseNdjson(null)).toEqual([]);
  });

  it('readers return [] / null for absent files', () => {
    expect(readSupervisorEvents(RUN, { storeDir })).toEqual([]);
    expect(readAllEvents(RUN, { storeDir })).toEqual([]);
    expect(readState(RUN, { storeDir })).toBe(null);
  });
});

describe('appendEvent', () => {
  it('fills eventId/ts/source defaults, validates, and writes one line', () => {
    const r = appendEvent(RUN, { type: 'run-created', data: { base: 'abc' } }, { storeDir, now: '2026-09-02T00:00:00Z' });
    expect(r.appended).toBe(true);
    expect(r.event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.event.ts).toBe('2026-09-02T00:00:00Z');
    expect(r.event.source).toBe('supervisor');
    expect(r.event.runId).toBe(RUN);
    const lines = readFileSync(getSupervisorEventsPath(RUN, { storeDir }), 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(r.event);
    expect(Object.keys(JSON.parse(lines[0]))).toEqual([
      'version', 'eventId', 'ts', 'runId', 'laneId', 'type', 'source', 'actionId', 'evidenceRef', 'data',
    ]);
  });

  it('rejects an invalid envelope without writing', () => {
    const r = appendEvent(RUN, { type: 'Bad Type' }, { storeDir });
    expect(r.appended).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(existsSync(getSupervisorEventsPath(RUN, { storeDir }))).toBe(false);
    const foreign = appendEvent(RUN, { type: 'run-created', runId: 'other' }, { storeDir });
    expect(foreign.appended).toBe(false);
    expect(foreign.errors[0]).toContain('other');
  });

  it('same actionId twice → second is a duplicate, nothing appended', () => {
    const a = appendEvent(RUN, { type: 'retry-scheduled', laneId: 'ui', actionId: 'retry:ui:2' }, { storeDir });
    const b = appendEvent(RUN, { type: 'retry-scheduled', laneId: 'ui', actionId: 'retry:ui:2' }, { storeDir });
    expect(a.appended).toBe(true);
    expect(b).toEqual({ appended: false, duplicate: true, existing: a.event });
    expect(readSupervisorEvents(RUN, { storeDir })).toHaveLength(1);
    const c = appendEvent(RUN, { type: 'retry-scheduled', laneId: 'ui', actionId: 'retry:ui:3' }, { storeDir });
    expect(c.appended).toBe(true);
  });

  it('normalizeEnvelope keeps caller values and surfaces unknown keys', () => {
    const n = normalizeEnvelope(RUN, { type: 't', eventId: 'x', ts: 'T', source: 'git', extra: 1 });
    expect(n).toMatchObject({ eventId: 'x', ts: 'T', source: 'git', extra: 1 });
  });
});

describe('readAllEvents + rebuildState', () => {
  it('merges telemetry and supervisor streams sorted by ts, stably', () => {
    recordPhaseStart(RUN, 'PLAN', { storeDir, ts: '2026-09-02T00:01:00Z' });
    appendEvent(RUN, { type: 'run-created', ts: '2026-09-02T00:00:00Z' }, { storeDir });
    appendEvent(RUN, { type: 'lane-heartbeat', laneId: 'a', ts: '2026-09-02T00:01:00Z' }, { storeDir });
    // A hand-edited / clock-skewed line: appendEvent would refuse it, the reader must still keep it (last).
    appendFileSync(getSupervisorEventsPath(RUN, { storeDir }), `${JSON.stringify({ version: 1, eventId: 'skew', ts: 'not-a-date', runId: RUN, type: 'budget-warning', source: 'supervisor' })}
`);
    recordPhaseEnd(RUN, 'PLAN', { storeDir, ts: '2026-09-02T00:02:00Z' });
    const types = readAllEvents(RUN, { storeDir }).map((e) => e.type);
    expect(types).toEqual(['run-created', 'phase-start', 'lane-heartbeat', 'phase-end', 'budget-warning']);
  });

  it('writes state.json atomically; delete → rebuild → deep-equal and byte-equal; telemetry bytes untouched', () => {
    recordPhaseStart(RUN, 'PLAN', { storeDir, ts: '2026-09-02T00:00:00Z' });
    recordPhaseStart(RUN, 'OPEN', { storeDir, ts: '2026-09-02T00:01:00Z' });
    appendEvent(RUN, { type: 'lane-state-changed', laneId: 'a', ts: '2026-09-02T00:02:00Z', data: { to: 'RUNNING' } }, { storeDir });
    appendEvent(RUN, { type: 'lane-heartbeat', laneId: 'a', ts: '2026-09-02T00:03:00Z' }, { storeDir });
    const telPath = getSplitEventsPath(RUN, { storeDir });
    const telBefore = readFileSync(telPath);

    const first = rebuildState(RUN, { storeDir });
    expect(first.events).toBe(4);
    expect(first.state.state).toBe('PROVISIONING');
    expect(first.state.lanes.a.state).toBe('RUNNING');
    expect(first.path).toBe(getStatePath(RUN, { storeDir }));
    const bytes1 = readFileSync(first.path);
    expect(readState(RUN, { storeDir })).toEqual(first.state);

    unlinkSync(first.path);
    expect(readState(RUN, { storeDir })).toBe(null);
    const second = rebuildState(RUN, { storeDir });
    expect(second.state).toEqual(first.state);
    expect(second.warnings).toEqual(first.warnings);
    expect(readFileSync(second.path).equals(bytes1)).toBe(true);
    expect(readFileSync(telPath).equals(telBefore)).toBe(true);
    // no tmp droppings
    const leftovers = readFileSync(second.path, 'utf-8');
    expect(leftovers.endsWith('\n')).toBe(true);
    expect(existsSync(`${second.path}.tmp`)).toBe(false);
  });

  it('rebuild on a run with no files yields CREATED and still writes the cache', () => {
    const r = rebuildState('split-empty', { storeDir, now: '2026-09-02T00:00:00Z' });
    expect(r.events).toBe(0);
    expect(r.state.state).toBe('CREATED');
    expect(r.state.runId).toBe('split-empty');
    expect(existsSync(r.path)).toBe(true);
  });
});
