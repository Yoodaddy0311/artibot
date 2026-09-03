/**
 * Tests for escalation-controller — upward escalation, the downward branch in
 * the same file, and the autopilot ceiling retry.
 *
 * WHAT THESE TESTS CANNOT SEE (per PRD R-05): they prove the gates fire in the
 * written order on synthetic inputs. They do NOT show that escalating on a
 * refusal recovers anything, that two consecutive successes is the right
 * downgrade trigger (§4.1 names no N), or that two refusals is the right
 * exclusion threshold (no document names one). They also cannot see a caller
 * that never increments `attempts`, `consecutiveSuccesses` or
 * `health.refusals` — every count-based gate is only as real as its caller.
 *
 * @module tests/routing/escalation
 */

import { describe, expect, it } from 'vitest';

import { MODELS } from '../../lib/core/model-catalog.js';
import { PERFORMANCE_DIRECTIVES } from '../../lib/routing/execution-profile.js';
import {
  candidateTiers,
  CEILING_RETRY_OUTCOMES,
  CEILING_RETRY_TIER,
  DEFAULT_ESCALATION_POLICY,
  DOWNGRADE_ACTION_CLASSES,
  DOWNGRADE_ENABLED_PERFORMANCE,
  downgradeEnabled,
  ESCALATING_OUTCOMES,
  excludedTiers,
  OUTCOMES,
  resolveEscalation,
  resolvePerformance,
  TIER_LADDER,
} from '../../lib/routing/escalation-controller.js';

/** Every tier allowed — isolates a branch from the ceiling constraint. */
const ALL = ['haiku', 'sonnet', 'opus', 'fable'];

describe('exported contract', () => {
  it('mirrors the model-catalog tier order, ascending in price', () => {
    expect([...TIER_LADDER]).toEqual(Object.keys(MODELS));
    const prices = TIER_LADDER.map((tier) => MODELS[tier].priceInPerMTok);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('closes the outcome vocabulary at the five briefed values', () => {
    expect([...OUTCOMES]).toEqual(['empty', 'refusal', 'fail', 'review_reject', 'ok']);
  });

  it('treats every non-ok outcome as escalating', () => {
    expect([...ESCALATING_OUTCOMES]).toEqual(OUTCOMES.filter((o) => o !== 'ok'));
  });

  it('limits the ceiling retry to empty and refusal, as autopilot.md words it', () => {
    expect([...CEILING_RETRY_OUTCOMES]).toEqual(['empty', 'refusal']);
  });

  it('resolves frontier to opus for the ceiling retry', () => {
    expect(CEILING_RETRY_TIER).toBe('opus');
    expect(DEFAULT_ESCALATION_POLICY.ceilingRetryTier).toBe('opus');
  });

  it('allows exactly one ceiling retry (autopilot.md: 1회 재시도)', () => {
    expect(DEFAULT_ESCALATION_POLICY.ceilingRetries).toBe(1);
  });

  it('freezes every exported table', () => {
    expect(Object.isFrozen(TIER_LADDER)).toBe(true);
    expect(Object.isFrozen(OUTCOMES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ESCALATION_POLICY)).toBe(true);
    expect(Object.isFrozen(DOWNGRADE_ACTION_CLASSES)).toBe(true);
    expect(Object.isFrozen(DOWNGRADE_ENABLED_PERFORMANCE)).toBe(true);
  });

  it('returns a frozen decision', () => {
    const d = resolveEscalation({ outcome: 'fail', tier: 'sonnet', allowedTiers: ALL });
    expect(Object.isFrozen(d)).toBe(true);
  });
});

describe('input guards', () => {
  it('makes no tier change for an outcome outside the allowlist', () => {
    for (const outcome of ['success', 'timeout', '', undefined, 42]) {
      const d = resolveEscalation({ outcome, tier: 'opus', allowedTiers: ALL });
      expect(d).toEqual({ nextTier: null, reason: 'unknown-outcome', kind: null });
    }
  });

  it('makes no tier change for a tier off the ladder', () => {
    const d = resolveEscalation({ outcome: 'fail', tier: 'gpt', allowedTiers: ALL });
    expect(d).toEqual({ nextTier: null, reason: 'unknown-tier', kind: null });
  });

  it('makes no tier change when the allowed set is empty or absent', () => {
    expect(resolveEscalation({ outcome: 'fail', tier: 'opus', allowedTiers: [] }).reason)
      .toBe('no-allowed-tier');
    expect(resolveEscalation({ outcome: 'fail', tier: 'opus' }).reason)
      .toBe('no-allowed-tier');
  });

  it('never throws on junk input', () => {
    for (const bad of [undefined, null, {}, { outcome: {}, tier: [] }]) {
      expect(() => resolveEscalation(bad)).not.toThrow();
      expect(resolveEscalation(bad).nextTier).toBeNull();
    }
  });
});

describe('escalation — upward', () => {
  it('climbs one rung on a failure', () => {
    const d = resolveEscalation({ outcome: 'fail', tier: 'sonnet', allowedTiers: ALL });
    expect(d).toEqual({ nextTier: 'opus', reason: 'escalate:fail', kind: 'escalate' });
  });

  it('climbs for every escalating outcome', () => {
    for (const outcome of ESCALATING_OUTCOMES) {
      const d = resolveEscalation({ outcome, tier: 'haiku', allowedTiers: ALL });
      expect(d.nextTier).toBe('sonnet');
      expect(d.kind).toBe('escalate');
    }
  });

  it('skips rungs that are not allowed rather than proposing them', () => {
    const d = resolveEscalation({
      outcome: 'fail', tier: 'haiku', allowedTiers: ['haiku', 'fable'],
    });
    expect(d.nextTier).toBe('fable');
  });

  it('accepts a Set, which is what allowedTiers() returns', () => {
    const d = resolveEscalation({
      outcome: 'fail', tier: 'opus', allowedTiers: new Set(['opus', 'fable']),
    });
    expect(d.nextTier).toBe('fable');
  });

  it('cannot exceed the allowed ceiling — a denylisted tier stays unreachable', () => {
    // security-reviewer's ceiling is opus (fable denylisted).
    const d = resolveEscalation({
      outcome: 'refusal', tier: 'opus', allowedTiers: ['opus'], attempts: 0,
    });
    expect(d.nextTier).toBeNull();
    expect(d.kind).toBeNull();
  });

  it('escalates regardless of profile — maximum does not disable upward moves', () => {
    const d = resolveEscalation({
      outcome: 'fail', tier: 'sonnet', allowedTiers: ALL, profile: { performance: 'maximum' },
    });
    expect(d.kind).toBe('escalate');
  });
});

describe('escalation — ceiling retry (autopilot.md 빈-결과 휴리스틱)', () => {
  const atCeiling = { tier: 'fable', allowedTiers: ALL, attempts: 0 };

  it('retries an empty fable result once on frontier', () => {
    const d = resolveEscalation({ outcome: 'empty', ...atCeiling });
    expect(d).toEqual({
      nextTier: 'opus', reason: 'ceiling-retry:frontier', kind: 'escalate',
    });
  });

  it('retries a refusal the same way', () => {
    expect(resolveEscalation({ outcome: 'refusal', ...atCeiling }).nextTier).toBe('opus');
  });

  it('reports retry-exhausted on the second empty result (caller then PAUSES)', () => {
    const d = resolveEscalation({ outcome: 'empty', ...atCeiling, attempts: 1 });
    expect(d).toEqual({ nextTier: null, reason: 'retry-exhausted', kind: null });
  });

  it('does not retry a fail or a review_reject at the ceiling', () => {
    for (const outcome of ['fail', 'review_reject']) {
      const d = resolveEscalation({ outcome, ...atCeiling });
      expect(d).toEqual({ nextTier: null, reason: 'ceiling', kind: null });
    }
  });

  it('does not retry when the frontier tier is outside the allowed set', () => {
    const d = resolveEscalation({
      outcome: 'empty', tier: 'fable', allowedTiers: ['fable'], attempts: 0,
    });
    expect(d).toEqual({ nextTier: null, reason: 'retry-tier-not-allowed', kind: null });
  });

  it('does not retry into the tier that just produced the empty result', () => {
    const d = resolveEscalation({
      outcome: 'empty', tier: 'opus', allowedTiers: ['opus'], attempts: 0,
    });
    expect(d).toEqual({ nextTier: null, reason: 'ceiling', kind: null });
  });

  it('stays available under --fast, because it is labelled escalate not downgrade', () => {
    const d = resolveEscalation({
      outcome: 'empty', ...atCeiling, profile: { performance: 'maximum' },
    });
    expect(d.nextTier).toBe('opus');
    expect(d.kind).toBe('escalate');
  });
});

describe('downgrade — the branch, not a second module', () => {
  const ready = {
    outcome: 'ok',
    tier: 'fable',
    allowedTiers: ALL,
    actionClass: 'status',
    consecutiveSuccesses: 2,
  };

  it('steps down one allowed rung under balanced', () => {
    const d = resolveEscalation({ ...ready, profile: { performance: 'balanced' } });
    expect(d).toEqual({ nextTier: 'opus', reason: 'downgrade:status', kind: 'downgrade' });
  });

  it('is disabled under maximum and split (§4.3, 07:85-98)', () => {
    for (const performance of ['maximum', 'split']) {
      const d = resolveEscalation({ ...ready, profile: { performance } });
      expect(d).toEqual({
        nextTier: null, reason: 'downgrade-disabled:performance', kind: null,
      });
    }
  });

  it('is disabled for the {priority} profile shape too', () => {
    const d = resolveEscalation({ ...ready, profile: { performance: { priority: 'split' } } });
    expect(d.reason).toBe('downgrade-disabled:performance');
  });

  it('is disabled when performance is absent — the allowlist has no default-on', () => {
    expect(resolveEscalation(ready).reason).toBe('downgrade-disabled:performance');
    expect(resolveEscalation({ ...ready, profile: {} }).reason)
      .toBe('downgrade-disabled:performance');
  });

  it('is disabled for a value outside the allowlist, so a new one fails closed', () => {
    const d = resolveEscalation({ ...ready, profile: { performance: 'economy' } });
    expect(d.reason).toBe('downgrade-disabled:performance');
  });

  it('holds unless the action class is a cheap one', () => {
    const d = resolveEscalation({
      ...ready, actionClass: 'architecture', profile: { performance: 'balanced' },
    });
    expect(d).toEqual({ nextTier: null, reason: 'downgrade-hold:action-class', kind: null });
  });

  it('accepts each of the three cheap action classes', () => {
    for (const actionClass of DOWNGRADE_ACTION_CLASSES) {
      const d = resolveEscalation({
        ...ready, actionClass, profile: { performance: 'balanced' },
      });
      expect(d.kind).toBe('downgrade');
      expect(d.reason).toBe(`downgrade:${actionClass}`);
    }
  });

  it('holds until the consecutive-success count is met', () => {
    const d = resolveEscalation({
      ...ready, consecutiveSuccesses: 1, profile: { performance: 'balanced' },
    });
    expect(d).toEqual({ nextTier: null, reason: 'downgrade-hold:successes', kind: null });
  });

  it('holds when the caller keeps no success count at all', () => {
    const { consecutiveSuccesses: _drop, ...noCount } = ready;
    const d = resolveEscalation({ ...noCount, profile: { performance: 'balanced' } });
    expect(d.reason).toBe('downgrade-hold:successes');
  });

  it('steps down one rung at a time, not to the floor', () => {
    const d = resolveEscalation({
      ...ready, tier: 'fable', allowedTiers: ['haiku', 'opus', 'fable'],
      profile: { performance: 'balanced' },
    });
    expect(d.nextTier).toBe('opus');
  });

  it('holds at the floor of the allowed set', () => {
    const d = resolveEscalation({
      ...ready, tier: 'haiku', profile: { performance: 'balanced' },
    });
    expect(d).toEqual({ nextTier: null, reason: 'downgrade-hold:floor', kind: null });
  });

  it('exports no separate downgrade entry point (01 §13)', async () => {
    const mod = await import('../../lib/routing/escalation-controller.js');
    expect(Object.keys(mod).some((k) => /^downgrade[A-Z]/.test(k) && k !== 'downgradeEnabled'))
      .toBe(false);
  });
});

describe('downgradeEnabled', () => {
  it('is true only for an explicit allowlisted performance value', () => {
    expect(downgradeEnabled({ performance: 'balanced' })).toBe(true);
    expect(downgradeEnabled({ performance: { priority: 'balanced' } })).toBe(true);
    expect(downgradeEnabled({ performance: 'maximum' })).toBe(false);
    expect(downgradeEnabled({})).toBe(false);
    expect(downgradeEnabled(undefined)).toBe(false);
  });

  it('keeps the allowlist at the one value §4.3 attests', () => {
    expect([...DOWNGRADE_ENABLED_PERFORMANCE]).toEqual(['balanced']);
  });
});

describe('execution-profile directives (T-26) as an injected port', () => {
  const ready = {
    outcome: 'ok',
    tier: 'fable',
    allowedTiers: ALL,
    actionClass: 'status',
    consecutiveSuccesses: 2,
  };

  it('takes downgradeEnabled from the directives rather than re-deciding', () => {
    for (const [priority, directives] of Object.entries(PERFORMANCE_DIRECTIVES)) {
      const d = resolveEscalation({ ...ready, directives });
      expect(d.kind).toBe(directives.downgradeEnabled ? 'downgrade' : null);
      expect(directives.downgradeEnabled).toBe(priority === 'balanced');
    }
  });

  it('lets a directive override a contradicting profile, so the two cannot drift', () => {
    const d = resolveEscalation({
      ...ready,
      profile: { performance: 'maximum' },
      directives: PERFORMANCE_DIRECTIVES.balanced,
    });
    expect(d.kind).toBe('downgrade');
  });

  it('honours a directive that enables downgrade where the fallback would not', () => {
    // T-26 defaults an ABSENT performance to balanced; the bare-profile
    // fallback here does not. The directive resolves that difference.
    expect(downgradeEnabled({}, { downgradeEnabled: true })).toBe(true);
    expect(downgradeEnabled({ performance: 'balanced' }, { downgradeEnabled: false }))
      .toBe(false);
  });

  it('ignores a non-boolean directive and falls back to the allowlist', () => {
    expect(downgradeEnabled({ performance: 'balanced' }, { downgradeEnabled: 'yes' }))
      .toBe(true);
    expect(downgradeEnabled({ performance: 'maximum' }, {})).toBe(false);
  });
});

describe('resolvePerformance', () => {
  it('reads both profile shapes and returns null otherwise', () => {
    expect(resolvePerformance({ performance: 'split' })).toBe('split');
    expect(resolvePerformance({ performance: { priority: 'maximum' } })).toBe('maximum');
    expect(resolvePerformance({ performance: 7 })).toBeNull();
    expect(resolvePerformance(undefined)).toBeNull();
  });
});

describe('provider health', () => {
  it('excludes a tier once refusals reach the threshold', () => {
    expect(excludedTiers({ refusals: { fable: 2, opus: 1 } }, 2)).toEqual(['fable']);
  });

  it('excludes nothing without a refusal map', () => {
    expect(excludedTiers(undefined, 2)).toEqual([]);
    expect(excludedTiers({ refusals: null }, 2)).toEqual([]);
  });

  it('skips an excluded rung when escalating', () => {
    const d = resolveEscalation({
      outcome: 'fail',
      tier: 'haiku',
      allowedTiers: ALL,
      health: { refusals: { sonnet: 3 } },
    });
    expect(d.nextTier).toBe('opus');
  });

  it('ignores exclusions rather than stranding the caller with no candidate', () => {
    const d = resolveEscalation({
      outcome: 'fail',
      tier: 'sonnet',
      allowedTiers: ['sonnet', 'opus'],
      health: { refusals: { sonnet: 5, opus: 5 } },
    });
    expect(d.nextTier).toBe('opus');
    expect(d.reason).toContain('health-exclusion-ignored');
  });

  it('honours a caller-supplied exclusion threshold', () => {
    const d = resolveEscalation({
      outcome: 'fail',
      tier: 'haiku',
      allowedTiers: ALL,
      health: { refusals: { sonnet: 1 } },
      policy: { refusalExclusionThreshold: 1 },
    });
    expect(d.nextTier).toBe('opus');
  });
});

describe('candidateTiers', () => {
  it('orders by ladder position, not by the caller argument order', () => {
    const { tiers } = candidateTiers(['fable', 'haiku', 'opus'], TIER_LADDER, []);
    expect(tiers).toEqual(['haiku', 'opus', 'fable']);
  });

  it('drops tiers that are not on the ladder', () => {
    const { tiers } = candidateTiers(['opus', 'gpt'], TIER_LADDER, []);
    expect(tiers).toEqual(['opus']);
  });

  it('reports when exclusions had to be ignored', () => {
    const r = candidateTiers(['opus'], TIER_LADDER, ['opus']);
    expect(r).toEqual({ tiers: ['opus'], exclusionsIgnored: true });
  });
});

describe('ladder injection', () => {
  it('uses an injected ladder over the built-in one', () => {
    const d = resolveEscalation({
      outcome: 'fail', tier: 'a', allowedTiers: ['a', 'b'], ladder: ['a', 'b'],
    });
    expect(d.nextTier).toBe('b');
  });

  it('falls back to TIER_LADDER for an empty or non-array ladder', () => {
    const d = resolveEscalation({
      outcome: 'fail', tier: 'opus', allowedTiers: ALL, ladder: [],
    });
    expect(d.nextTier).toBe('fable');
  });
});
