/**
 * `lib/supervisor/state-reducer` — PR-SV01 acceptance.
 *
 *   - same stream → deep-equal AND byte-equal (JSON) derived state
 *   - unknown event → warning, no transition
 *   - terminal states never regress (run and lane)
 *   - split-telemetry lines map onto the run machine forward-only
 *
 * Fixture scale caveat: these streams are a handful of events. The 15-line
 * live fixture is exercised in `replay-fixture.test.js`; a run with N lanes
 * and hundreds of heartbeats has not been replayed (no such run exists yet).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { reduce } from '../../lib/supervisor/state-reducer.js';
import { validateRunState } from '../../lib/supervisor/contracts.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESIGN = path.resolve(PLUGIN_ROOT, '..', '..', 'docs', 'artibot-vnext-autonomous-runtime-design-v1.0', 'artibot-vnext-design');

let seq = 0;
/**
 * @param {string} type
 * @param {object} [extra]
 * @returns {object}
 */
function env(type, extra = {}) {
  seq += 1;
  return {
    version: 1,
    eventId: `e${seq}`,
    ts: `2026-09-01T08:${String(seq).padStart(2, '0')}:00Z`,
    runId: 'split-t',
    laneId: null,
    type,
    source: 'supervisor',
    actionId: null,
    evidenceRef: null,
    ...extra,
  };
}

/**
 * @param {string} type
 * @param {string|null} phase
 * @param {object} [extra]
 * @returns {object}
 */
function tel(type, phase, extra = {}) {
  seq += 1;
  return {
    ts: `2026-08-27T10:${String(seq).padStart(2, '0')}:00.000Z`,
    sessionId: 'split-t',
    phase,
    type,
    level: 'info',
    message: `${phase ?? ''} ${type}`,
    ...extra,
  };
}

describe('determinism', () => {
  it('same stream → deep-equal and JSON-byte-equal state; input untouched', () => {
    const events = [
      env('run-created', { data: { base: 'abc' } }),
      env('lane-state-changed', { laneId: 'ui', source: 'scheduler', data: { from: 'READY', to: 'RUNNING' } }),
      env('lane-heartbeat', { laneId: 'ui', source: 'worker', data: { head: 'h1' } }),
      env('checkpoint-written', { laneId: 'ui', source: 'worker', data: { seq: 3 } }),
    ];
    const frozen = JSON.stringify(events);
    const a = reduce(events);
    const b = reduce(events);
    expect(a).toEqual(b);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(JSON.stringify(events)).toBe(frozen);
    expect(validateRunState(a.state).ok).toBe(true);
  });

  it('empty stream → CREATED with `now` timestamps and null runId', () => {
    const r = reduce([], { now: '2026-09-02T00:00:00Z' });
    expect(r.state.state).toBe('CREATED');
    expect(r.state.createdAt).toBe('2026-09-02T00:00:00Z');
    expect(r.state.updatedAt).toBe('2026-09-02T00:00:00Z');
    expect(r.state.runId).toBe(null);
    expect(r.warnings).toEqual([]);
  });

  it('reproduces the design example run-state from the design example stream', () => {
    let text;
    let expected;
    try {
      text = readFileSync(path.join(DESIGN, 'examples', 'events.example.ndjson'), 'utf-8');
      expected = JSON.parse(readFileSync(path.join(DESIGN, 'examples', 'run-state.example.json'), 'utf-8'));
    } catch {
      return; // design docs absent
    }
    const events = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    // The example stream has no run-state-changed → the example's EXECUTING is asserted only at lane level.
    const { state, warnings } = reduce(events);
    expect(warnings).toEqual([]);
    expect(state.runId).toBe(expected.runId);
    expect(state.createdAt).toBe(expected.createdAt);
    const lane = state.lanes['work-ui'];
    expect(lane.state).toBe(expected.lanes['work-ui'].state);
    expect(lane.attempt).toBe(expected.lanes['work-ui'].attempt);
    expect(lane.checkpointSeq).toBe(expected.lanes['work-ui'].checkpointSeq);
    expect(lane.lastHeartbeatAt).toBe(expected.lanes['work-ui'].lastHeartbeatAt);
    expect(validateRunState(state).ok).toBe(true);
  });
});

describe('fail-safe', () => {
  it('unknown event type → warning, no transition, updatedAt untouched', () => {
    const base = [env('run-created'), env('run-state-changed', { data: { to: 'PLANNED' } })];
    const before = reduce(base).state;
    const { state, warnings } = reduce([...base, env('lane-blocked', { laneId: 'ui' })]);
    expect(state).toEqual(before);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'unknown-event', index: 2, type: 'lane-blocked' });
  });

  it('non-object and foreign-run events are warnings, not crashes', () => {
    const { state, warnings } = reduce([env('run-created'), null, 'x', env('run-state-changed', { runId: 'other', data: { to: 'PLANNED' } })]);
    expect(state.state).toBe('CREATED');
    expect(warnings.map((w) => w.code)).toEqual(['malformed-event', 'malformed-event', 'foreign-run']);
  });

  it('run terminal never regresses (COMPLETED / FAILED_TERMINAL / CANCELLED)', () => {
    for (const terminal of ['COMPLETED', 'FAILED_TERMINAL', 'CANCELLED']) {
      const { state, warnings } = reduce([
        env('run-created'),
        env('run-state-changed', { data: { to: terminal } }),
        env('run-state-changed', { data: { to: 'EXECUTING' } }),
        tel('phase-start', 'PLAN'),
      ]);
      expect(state.state).toBe(terminal);
      expect(warnings.filter((w) => w.code === 'terminal-regress')).toHaveLength(1);
    }
  });

  it('lane terminal never regresses; same-state repeat is not a warning', () => {
    const { state, warnings } = reduce([
      env('lane-state-changed', { laneId: 'a', data: { to: 'DONE' } }),
      env('lane-state-changed', { laneId: 'a', data: { to: 'RUNNING' } }),
      env('lane-state-changed', { laneId: 'a', data: { to: 'DONE' } }),
    ]);
    expect(state.lanes.a.state).toBe('DONE');
    expect(warnings.map((w) => w.code)).toEqual(['terminal-regress']);
  });

  it('ambiguous payloads (unknown to-state, unknown verdict, missing laneId) warn without change', () => {
    const { state, warnings } = reduce([
      env('run-state-changed', { data: { to: 'RUNNING' } }),
      env('lane-state-changed', { laneId: 'a', data: { to: 'running' } }),
      env('review-result', { laneId: 'a', data: { verdict: 'LGTM' } }),
      env('lane-heartbeat'),
    ]);
    expect(state.state).toBe('CREATED');
    expect(state.lanes.a.state).toBe('PENDING');
    expect(state.lanes.a.reviewVerdict).toBe(null);
    expect(warnings.map((w) => w.code)).toEqual(['unknown-run-state', 'unknown-lane-state', 'unknown-verdict', 'lane-missing']);
  });

  it('duplicate run-created / lane-created are warnings', () => {
    const { state, warnings } = reduce([
      env('run-created', { data: { base: 'a' } }),
      env('run-created', { data: { base: 'b' } }),
      env('lane-created', { laneId: 'x', data: { ownedPaths: ['p/'] } }),
      env('lane-created', { laneId: 'x', data: { ownedPaths: ['q/'] } }),
    ]);
    expect(state.base).toBe('a');
    expect(state.lanes.x.ownedPaths).toEqual(['p/']);
    expect(warnings.map((w) => w.code)).toEqual(['duplicate-run-created', 'duplicate-lane-created']);
  });
});

describe('lane bookkeeping', () => {
  it('attempt increments on fresh RUNNING entries only; from-mismatch warns but applies', () => {
    const { state, warnings } = reduce([
      env('lane-state-changed', { laneId: 'a', data: { from: 'PENDING', to: 'READY' } }),
      env('lane-state-changed', { laneId: 'a', data: { from: 'READY', to: 'RUNNING' } }),
      env('lane-state-changed', { laneId: 'a', data: { from: 'RUNNING', to: 'CHECKPOINTING' } }),
      env('lane-state-changed', { laneId: 'a', data: { from: 'CHECKPOINTING', to: 'RUNNING' } }),
      env('lane-state-changed', { laneId: 'a', data: { from: 'RUNNING', to: 'FAILED_RECOVERABLE' } }),
      env('lane-state-changed', { laneId: 'a', data: { from: 'READY', to: 'RUNNING' } }), // emitter skipped READY
    ]);
    expect(state.lanes.a.state).toBe('RUNNING');
    expect(state.lanes.a.attempt).toBe(2);
    expect(warnings.map((w) => w.code)).toEqual(['from-mismatch']);
  });

  it('heartbeat/progress/attach/checkpoint update liveness, head, worker, seq; review fields; exceptions', () => {
    const { state } = reduce([
      env('worker-attached', { laneId: 'a', source: 'worker', data: { workerId: 's-1' } }),
      env('lane-progress', { laneId: 'a', source: 'worker', data: { head: 'abc' } }),
      env('checkpoint-written', { laneId: 'a', source: 'worker', data: { seq: 2 } }),
      env('checkpoint-written', { laneId: 'a', source: 'worker', data: { seq: 1 } }), // never decreases
      env('review-requested', { laneId: 'a', source: 'supervisor' }),
      env('review-result', { laneId: 'a', source: 'reviewer', data: { verdict: 'CHANGES_REQUESTED' } }),
      env('human-required', { laneId: 'a', source: 'supervisor' }),
      env('human-required', { laneId: 'a', source: 'supervisor' }),
      env('human-resolved', { laneId: 'a', source: 'human' }),
      env('worker-detached', { laneId: 'a', source: 'hook' }),
      env('budget-warning'), env('gate-started'), env('gate-result'), env('retry-scheduled', { laneId: 'a' }), env('budget-exhausted'),
    ]);
    const a = state.lanes.a;
    expect(a.head).toBe('abc');
    expect(a.checkpointSeq).toBe(2);
    expect(a.reviewVerdict).toBe('CHANGES_REQUESTED');
    expect(a.workerId).toBe(null);
    expect(a.lastHeartbeatAt).toMatch(/^2026-/);
    expect(state.exceptionCount).toBe(1);
    expect(state.state).toBe('CREATED'); // inert types moved nothing
  });
});

describe('telemetry mapping', () => {
  it('PLAN → PLANNED, OPEN → PROVISIONING, DISPATCH → READY, INTEGRATE → INTEGRATING, landed → COMPLETED', () => {
    const steps = [
      [tel('wall-clock-start', null, { data: { segment: 'run', humanWait: false } }), 'CREATED'],
      [tel('phase-start', 'PLAN'), 'PLANNED'],
      [tel('fast-profile-planned', 'PLAN', { data: {} }), 'PLANNED'],
      [tel('phase-end', 'PLAN'), 'PLANNED'],
      [tel('phase-start', 'OPEN'), 'PROVISIONING'],
      [tel('phase-start', 'DISPATCH'), 'READY'],
      [tel('phase-end', 'DISPATCH', { message: 'refused: no windows' }), 'READY'],
      [tel('phase-start', 'INTEGRATE'), 'INTEGRATING'],
      [tel('phase-end', 'INTEGRATE', { message: 'landed 41f7f7e9 rebuilds=0' }), 'COMPLETED'],
    ];
    const events = [];
    for (const [ev, expected] of steps) {
      events.push(ev);
      expect(reduce(events).state.state, ev.type + ' ' + ev.phase).toBe(expected);
    }
    const { state, warnings } = reduce(events);
    expect(state.createdAt).toBe(events[0].ts);
    expect(state.updatedAt).toBe(events.at(-1).ts);
    expect(warnings).toEqual([]);
  });

  it('DISPATCH end with data.status ready and wait-limbs segment → EXECUTING', () => {
    expect(reduce([tel('phase-start', 'DISPATCH'), tel('phase-end', 'DISPATCH', { data: { status: 'ready' } })]).state.state).toBe('EXECUTING');
    expect(reduce([tel('phase-start', 'DISPATCH'), tel('wall-clock-start', null, { data: { segment: 'wait-limbs', humanWait: false } })]).state.state).toBe('EXECUTING');
  });

  it('INTEGRATE end without a landed signal stays INTEGRATING with a warning', () => {
    const { state, warnings } = reduce([tel('phase-start', 'INTEGRATE'), tel('phase-end', 'INTEGRATE', { message: 'conflict: 2 files' })]);
    expect(state.state).toBe('INTEGRATING');
    expect(warnings.map((w) => w.code)).toEqual(['integrate-not-landed']);
  });

  it('replayed earlier phase is ignored silently; side state resumes forward', () => {
    const { state, warnings } = reduce([
      tel('phase-start', 'DISPATCH'), tel('wall-clock-start', null, { data: { segment: 'wait-limbs' } }), tel('phase-start', 'PLAN'),
    ]);
    expect(state.state).toBe('EXECUTING');
    expect(warnings).toEqual([]);
    const side = reduce([
      env('run-state-changed', { data: { to: 'BLOCKED' } }),
      tel('phase-start', 'INTEGRATE'),
    ]);
    expect(side.state.state).toBe('INTEGRATING');
  });

  it('unknown telemetry type warns; telemetry never creates lanes', () => {
    const { state, warnings } = reduce([tel('log', null), tel('phase-start', 'OPEN')]);
    expect(warnings.map((w) => w.code)).toEqual(['unknown-event']);
    expect(state.lanes).toEqual({});
  });
});
