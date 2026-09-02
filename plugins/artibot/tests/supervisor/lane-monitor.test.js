/**
 * `lib/supervisor/lane-monitor` — design §03 stuck-detection table.
 *
 * Not covered: the thresholds' *values* against real runs (design: "config
 * 로 두고 실데이터로 조정"). Zero real heartbeat emitters exist as of
 * 2026-09-02, so every heartbeat here is synthetic.
 */

import { describe, expect, it } from 'vitest';

import {
  assessLane,
  DEFAULT_THRESHOLDS,
  HEALTH_STATES,
  opsStateToLaneState,
  readLaneOpsState,
} from '../../lib/supervisor/lane-monitor.js';

const NOW = Date.parse('2026-09-02T12:00:00Z');
/**
 * @param {number} secondsAgo
 * @returns {string}
 */
const ago = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

describe('assessLane — heartbeat bands', () => {
  it.each([
    [0, 'healthy'],
    [479, 'healthy'],
    [480, 'suspect'],
    [899, 'suspect'],
    [900, 'inspect'],
    [86400, 'inspect'],
  ])('heartbeat %ds ago → %s', (secs, health) => {
    const r = assessLane({ lane: { state: 'RUNNING', lastHeartbeatAt: ago(secs) }, nowMs: NOW });
    expect(r.health).toBe(health);
    expect(r.signal).toBe('heartbeat');
    expect(r.ageSeconds).toBe(secs);
  });

  it('falls back to the last commit when there is no heartbeat, and says so', () => {
    const r = assessLane({ lane: { state: 'RUNNING', lastHeartbeatAt: null }, nowMs: NOW, gitEvidence: { lastCommitAt: ago(600) } });
    expect(r).toMatchObject({ health: 'suspect', signal: 'commit', ageSeconds: 600 });
  });

  it('honours caller thresholds and collapses a misordered pair instead of inverting it', () => {
    const t = { suspectHeartbeatSeconds: 60, staleHeartbeatSeconds: 120 };
    expect(assessLane({ lane: { lastHeartbeatAt: ago(59) }, nowMs: NOW, thresholds: t }).health).toBe('healthy');
    expect(assessLane({ lane: { lastHeartbeatAt: ago(61) }, nowMs: NOW, thresholds: t }).health).toBe('suspect');
    expect(assessLane({ lane: { lastHeartbeatAt: ago(121) }, nowMs: NOW, thresholds: t }).health).toBe('inspect');
    const bad = { suspectHeartbeatSeconds: 1000, staleHeartbeatSeconds: 100 };
    expect(assessLane({ lane: { lastHeartbeatAt: ago(50) }, nowMs: NOW, thresholds: bad }).health).toBe('healthy');
    expect(assessLane({ lane: { lastHeartbeatAt: ago(150) }, nowMs: NOW, thresholds: bad }).health).toBe('inspect');
    expect(DEFAULT_THRESHOLDS).toEqual({ suspectHeartbeatSeconds: 480, staleHeartbeatSeconds: 900 });
  });
});

describe('assessLane — done / session / unknown', () => {
  it('git complete wins over everything; lane DONE also reads done', () => {
    expect(assessLane({ lane: { state: 'RUNNING', lastHeartbeatAt: ago(99999) }, nowMs: NOW, gitEvidence: { complete: true }, session: { present: false } }).health).toBe('done');
    expect(assessLane({ lane: { state: 'DONE' }, nowMs: NOW }).health).toBe('done');
  });

  it('session absent: dirty → recoverable, clean → restart, unmeasured → unknown', () => {
    expect(assessLane({ lane: { state: 'RUNNING' }, nowMs: NOW, session: { present: false }, gitEvidence: { dirty: true } }).health).toBe('recoverable');
    expect(assessLane({ lane: { state: 'RUNNING' }, nowMs: NOW, session: { present: false }, gitEvidence: { dirty: false, lastCommitAt: ago(10) } }).health).toBe('restart');
    expect(assessLane({ lane: { state: 'RUNNING' }, nowMs: NOW, session: { present: false }, gitEvidence: { dirty: false } }).reason).toContain('no commit');
    expect(assessLane({ lane: { state: 'RUNNING' }, nowMs: NOW, session: { present: false }, gitEvidence: { dirty: null } }).health).toBe('unknown');
  });

  it('missing inputs never yield healthy', () => {
    expect(assessLane({}).health).toBe('unknown');
    expect(assessLane({ lane: null, nowMs: NOW }).health).toBe('unknown');
    expect(assessLane({ lane: { lastHeartbeatAt: 'garbage' }, nowMs: NOW }).health).toBe('unknown');
    expect(assessLane({ lane: { lastHeartbeatAt: ago(1) }, nowMs: NaN }).health).toBe('unknown');
    expect(assessLane({ lane: { lastHeartbeatAt: ago(-120) }, nowMs: NOW }).health).toBe('unknown'); // future = clock skew
    expect(assessLane({ lane: { lastHeartbeatAt: ago(-120) }, nowMs: NOW }).reason).toContain('future');
  });

  it('every returned health is in the allowlist', () => {
    const results = [
      assessLane({ lane: { lastHeartbeatAt: ago(1) }, nowMs: NOW }),
      assessLane({ lane: { lastHeartbeatAt: ago(500) }, nowMs: NOW }),
      assessLane({ lane: { lastHeartbeatAt: ago(5000) }, nowMs: NOW }),
      assessLane({ nowMs: NOW, session: { present: false }, gitEvidence: { dirty: true } }),
      assessLane({ nowMs: NOW, session: { present: false }, gitEvidence: { dirty: false } }),
      assessLane({ nowMs: NOW, gitEvidence: { complete: true } }),
      assessLane({}),
    ];
    expect(results.map((r) => r.health)).toEqual([...HEALTH_STATES]);
  });
});

describe('readLaneOpsState / opsStateToLaneState', () => {
  it('accepts string or { state }, only from the allowlist; everything else null', () => {
    const run = { lanes: { a: 'active', b: { state: 'review' }, c: { state: 'RUNNING' }, d: 'nope', e: 5 } };
    expect(readLaneOpsState(run, 'a')).toBe('active');
    expect(readLaneOpsState(run, 'b')).toBe('review');
    expect(readLaneOpsState(run, 'c')).toBe(null);
    expect(readLaneOpsState(run, 'd')).toBe(null);
    expect(readLaneOpsState(run, 'e')).toBe(null);
    expect(readLaneOpsState(run, 'zz')).toBe(null);
    expect(readLaneOpsState({ metrics: { lanes: { a: { started: 'x' } } } }, 'a')).toBe(null); // Ontology run.json shape: no top-level lanes
    expect(readLaneOpsState(null, 'a')).toBe(null);
    expect(readLaneOpsState(run, '')).toBe(null);
  });

  it('maps ops → design lane state', () => {
    expect(opsStateToLaneState('active')).toBe('RUNNING');
    expect(opsStateToLaneState('done')).toBe('DONE');
    expect(opsStateToLaneState('suspended')).toBe('WAITING_INPUT');
    expect(opsStateToLaneState('bogus')).toBe(null);
    expect(opsStateToLaneState(null)).toBe(null);
  });
});
