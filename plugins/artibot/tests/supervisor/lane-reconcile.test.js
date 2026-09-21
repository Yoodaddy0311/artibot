/**
 * `lib/supervisor/lane-reconcile` — design §3.5 (`ARTIBOT-5.0-DESIGN.md:198`)
 * "재개 규칙: state 읽기 → git 대조 → 불일치는 `blocked_by:['reconcile:…']`
 * fail-closed".
 *
 * ── Fixture policy (why heartbeats are null almost everywhere) ─────────────
 * `lastHeartbeatAt` is null in production: the supervisor envelope stream has
 * zero files, so nothing has ever written a heartbeat. `assessLane` therefore
 * falls back to `gitEvidence.lastCommitAt` for every live lane, and the
 * heartbeat branch is reachable only from a synthetic fixture. The default
 * fixture here is heartbeat-null for that reason; the ONE heartbeat case is
 * marked fixture-only so nobody reads it as evidence about a real run.
 *
 * Not covered here: whether the caller's `gitEvidence` is true — this module
 * is pure and believes its inputs. Producing that evidence (git log / status /
 * `Split-Limb: done` trailer) belongs to the caller.
 */

import { describe, expect, it } from 'vitest';

import * as barrel from '../../lib/supervisor/index.js';
import { HEALTH_STATES } from '../../lib/supervisor/lane-monitor.js';
import {
  RECONCILE_REASONS,
  reconcileLane,
  reconcileLanes,
} from '../../lib/supervisor/lane-reconcile.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');
/**
 * @param {number} secondsAgo
 * @returns {string}
 */
const ago = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

/** Health → the evidence bundle that produces it, heartbeat-null throughout. */
const HEALTH_FIXTURES = Object.freeze({
  healthy: { gitEvidence: { lastCommitAt: ago(10) } },
  suspect: { gitEvidence: { lastCommitAt: ago(600) } },
  inspect: { gitEvidence: { lastCommitAt: ago(5000) } },
  recoverable: { session: { present: false }, gitEvidence: { dirty: true } },
  restart: { session: { present: false }, gitEvidence: { dirty: false } },
  done: { gitEvidence: { complete: true } },
  unknown: {},
});

describe('reconcileLane — ops state outside the allowlist (the LIVE default)', () => {
  it.each([
    ['dispatched', 'run.json Wave 9'],
    ['landed', 'run-split-68e984w8.json Wave 8'],
    ['nope', 'typo'],
    [null, 'missing lanes block'],
  ])('%s (%s) → reconcile:ops-state-unknown', (raw) => {
    const runJson = raw === null ? { lanes: {} } : { lanes: { a: { state: raw } } };
    const [r] = reconcileLanes(runJson, { a: { gitEvidence: { lastCommitAt: ago(10) } } }, { nowMs: NOW });
    expect(r.limb).toBe('a');
    expect(r.opsState).toBe(null);
    expect(r.laneState).toBe(null);
    expect(r.blocked_by).toContain('reconcile:ops-state-unknown');
  });

  it('an allowlisted ops state does NOT emit ops-state-unknown', () => {
    const r = reconcileLane({ limb: 'a', opsState: 'active', nowMs: NOW, gitEvidence: { lastCommitAt: ago(10) } });
    expect(r.opsState).toBe('active');
    expect(r.laneState).toBe('RUNNING');
    expect(r.blocked_by).toEqual([]);
  });
});

describe('reconcileLane — health projection (all 7 values)', () => {
  it.each([
    ['healthy', []],
    ['suspect', ['reconcile:lane-suspect']],
    ['inspect', ['reconcile:lane-inspect']],
    ['recoverable', ['reconcile:lane-recoverable']],
    ['restart', ['reconcile:lane-restart']],
    ['unknown', ['reconcile:lane-unknown']],
  ])('health %s → %j', (health, expected) => {
    const r = reconcileLane({ limb: 'a', opsState: 'active', nowMs: NOW, ...HEALTH_FIXTURES[health] });
    expect(r.assessment.health).toBe(health);
    expect(r.blocked_by).toEqual(expected);
  });

  it('health done with ops state done is fully reconciled — no reason at all', () => {
    const r = reconcileLane({ limb: 'a', opsState: 'done', nowMs: NOW, gitEvidence: { complete: true } });
    expect(r.assessment.health).toBe('done');
    expect(r.blocked_by).toEqual([]);
  });

  it('covers every health value the monitor can return', () => {
    expect(Object.keys(HEALTH_FIXTURES).sort()).toEqual([...HEALTH_STATES].sort());
  });

  it('reads a heartbeat when one exists (FIXTURE-ONLY: production emits none)', () => {
    const r = reconcileLane({
      limb: 'a', opsState: 'active', nowMs: NOW,
      lane: { lastHeartbeatAt: ago(600) },
      gitEvidence: { lastCommitAt: ago(1) },
    });
    expect(r.assessment.signal).toBe('heartbeat');
    expect(r.blocked_by).toEqual(['reconcile:lane-suspect']);
  });
});

describe('reconcileLane — state vs git mismatch (fail-closed)', () => {
  it('ops state done but git does not say complete', () => {
    const r = reconcileLane({ limb: 'a', opsState: 'done', nowMs: NOW, gitEvidence: { complete: false, lastCommitAt: ago(10) } });
    expect(r.laneState).toBe('DONE');
    expect(r.blocked_by).toEqual(['reconcile:state-done-git-incomplete']);
  });

  it('unmeasured git completeness is a mismatch too — absence is not proof', () => {
    const r = reconcileLane({ limb: 'a', opsState: 'done', nowMs: NOW });
    expect(r.blocked_by).toContain('reconcile:state-done-git-incomplete');
  });

  it('git says complete but the ops state is not done', () => {
    const r = reconcileLane({ limb: 'a', opsState: 'active', nowMs: NOW, gitEvidence: { complete: true } });
    expect(r.assessment.health).toBe('done');
    expect(r.blocked_by).toEqual(['reconcile:git-complete-state-not-done']);
  });

  it('git complete on an unknown ops state reports BOTH reasons', () => {
    const r = reconcileLane({ limb: 'a', opsState: 'dispatched', nowMs: NOW, gitEvidence: { complete: true } });
    expect(r.blocked_by).toEqual(['reconcile:ops-state-unknown', 'reconcile:git-complete-state-not-done']);
  });

  it('an unknown ops state can stack a health reason as well', () => {
    const r = reconcileLane({ limb: 'a', opsState: 'landed', nowMs: NOW, gitEvidence: { lastCommitAt: ago(5000) } });
    expect(r.blocked_by).toEqual(['reconcile:ops-state-unknown', 'reconcile:lane-inspect']);
  });
});

describe('reconcileLanes — mapping over a run.json', () => {
  const runJson = {
    limbs: ['a', 'b', 'c'],
    lanes: { a: 'active', b: { state: 'done' }, c: { state: 'dispatched' } },
  };

  it('returns one entry per limb, in limbs order', () => {
    const out = reconcileLanes(runJson, {
      a: { gitEvidence: { lastCommitAt: ago(10) } },
      b: { gitEvidence: { complete: true } },
      c: { gitEvidence: { lastCommitAt: ago(10) } },
    }, { nowMs: NOW });
    expect(out.map((r) => r.limb)).toEqual(['a', 'b', 'c']);
    expect(out.map((r) => r.blocked_by)).toEqual([[], [], ['reconcile:ops-state-unknown']]);
  });

  it('includes lane keys missing from limbs[] rather than dropping them', () => {
    const out = reconcileLanes({ limbs: ['a'], lanes: { a: 'active', z: 'active' } }, {}, { nowMs: NOW });
    expect(out.map((r) => r.limb)).toEqual(['a', 'z']);
  });

  it('falls back to lane keys when limbs[] is absent, and to the evidence keys when both are', () => {
    expect(reconcileLanes({ lanes: { q: 'active' } }, {}, { nowMs: NOW }).map((r) => r.limb)).toEqual(['q']);
    expect(reconcileLanes(null, { q: {} }, { nowMs: NOW }).map((r) => r.limb)).toEqual(['q']);
    expect(reconcileLanes(null, null, { nowMs: NOW })).toEqual([]);
  });

  it('a limb with no evidence at all is unknown, never healthy', () => {
    const [r] = reconcileLanes({ limbs: ['a'], lanes: { a: 'active' } }, {}, { nowMs: NOW });
    expect(r.assessment.health).toBe('unknown');
    expect(r.blocked_by).toEqual(['reconcile:lane-unknown']);
  });

  it('honours caller thresholds', () => {
    const lanesInput = { a: { gitEvidence: { lastCommitAt: ago(100) } } };
    const strict = reconcileLanes({ limbs: ['a'], lanes: { a: 'active' } }, lanesInput, { nowMs: NOW, thresholds: { suspectHeartbeatSeconds: 10, staleHeartbeatSeconds: 60 } });
    expect(strict[0].blocked_by).toEqual(['reconcile:lane-inspect']);
  });
});

describe('reconcile reason vocabulary', () => {
  it('every declared reason carries the reconcile: prefix and nothing else', () => {
    expect(RECONCILE_REASONS.length).toBeGreaterThan(0);
    for (const reason of RECONCILE_REASONS) {
      expect(reason.startsWith('reconcile:')).toBe(true);
      expect(reason).not.toMatch(/^(lane|gate|human):/);
    }
    expect(Object.isFrozen(RECONCILE_REASONS)).toBe(true);
  });

  it('every reason this module actually emits is declared, and vice versa', () => {
    const emitted = new Set();
    const cases = [
      { opsState: 'dispatched', nowMs: NOW },
      ...HEALTH_STATES.map((h) => ({ opsState: 'active', nowMs: NOW, ...HEALTH_FIXTURES[h] })),
      { opsState: 'done', nowMs: NOW, gitEvidence: { complete: false, lastCommitAt: ago(1) } },
      { opsState: 'active', nowMs: NOW, gitEvidence: { complete: true } },
    ];
    for (const c of cases) {
      for (const reason of reconcileLane({ limb: 'a', ...c }).blocked_by) emitted.add(reason);
    }
    expect([...emitted].sort()).toEqual([...RECONCILE_REASONS].sort());
  });

  it('is pure: the same inputs give the same answer and nothing reads the wall clock', () => {
    const input = { limb: 'a', opsState: 'active', nowMs: NOW, gitEvidence: { lastCommitAt: ago(600) } };
    expect(reconcileLane(input)).toEqual(reconcileLane(input));
    expect(reconcileLane({ limb: 'a', opsState: 'active', gitEvidence: { lastCommitAt: ago(1) } }).assessment.health).toBe('unknown');
  });

  it('never throws on garbage input', () => {
    expect(reconcileLane().blocked_by).toContain('reconcile:ops-state-unknown');
    expect(reconcileLane({ limb: 5, opsState: 7, lane: 'x', gitEvidence: 'y', nowMs: 'z' }).limb).toBe(null);
    expect(reconcileLanes('nope', 'nope', 'nope')).toEqual([]);
  });
});

describe('the barrel exports this module', () => {
  it('re-exports all three names from lib/supervisor/index.js as the same references', () => {
    expect(barrel.RECONCILE_REASONS).toBe(RECONCILE_REASONS);
    expect(barrel.reconcileLane).toBe(reconcileLane);
    expect(barrel.reconcileLanes).toBe(reconcileLanes);
  });
});
