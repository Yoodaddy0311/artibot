/**
 * Tests for route-hysteresis — §28 Switch Economics, §29 overrides, §30
 * residency.
 *
 * WHAT THESE TESTS CANNOT SEE (per PRD R-05): every number below is arithmetic
 * over injected inputs. Nothing here validates that the seven terms MODEL the
 * real cost of a model switch, that the ±0.05 band is the right width, or that
 * residency 3 / cooldown 2 are the right counts — §30 says outright those are
 * to be calibrated by RouteBench, which does not exist. A green suite means
 * the formulas are the ones written down, not that they are correct.
 *
 * @module tests/routing/hysteresis
 */

import { describe, expect, it } from 'vitest';

import { getModel, MODELS } from '../../lib/core/model-catalog.js';
import { PERFORMANCE_DIRECTIVES } from '../../lib/routing/execution-profile.js';
import {
  BENEFIT_TERMS,
  COST_TERM_UNITS,
  COST_TERMS,
  DEFAULT_SWITCH_POLICY,
  evaluateSwitch,
  freshInputPrice,
  HYSTERESIS_BAND,
  MEASURED_USAGE_SOURCES,
  outputPrice,
  residencyBarrier,
  resolveCostWeight,
  resolvePerformance,
  SWITCH_OVERRIDES,
  UNPRICED_COST_TERMS,
} from '../../lib/routing/route-hysteresis.js';

/** Real catalog, injected as a port (the module imports nothing). */
const catalog = { getModel };

/** Inputs that clear the §30 residency barrier, so band logic is reachable. */
const resident = { actionsSinceSwitch: 10, catalog };

describe('exported contract', () => {
  it('names the seven §28 cost terms exactly as route-receipt.schema.json does', () => {
    expect([...COST_TERMS]).toEqual([
      'contextSerialization',
      'contextRebuild',
      'cacheLoss',
      'handoffTokens',
      'handoffLatency',
      'reorientationRisk',
      'expectedRetry',
    ]);
  });

  it('names the four §28 benefit terms', () => {
    expect([...BENEFIT_TERMS]).toEqual(['quality', 'futureCost', 'latency', 'failure']);
  });

  it('carries a unit for every cost term, so the mixed units stay visible', () => {
    expect(Object.keys(COST_TERM_UNITS).sort()).toEqual([...COST_TERMS].sort());
  });

  it('keeps §30 heuristics at their written values and flags them as policy', () => {
    expect(DEFAULT_SWITCH_POLICY.minimum_residency).toBe(3);
    expect(DEFAULT_SWITCH_POLICY.cooldown).toBe(2);
    expect(DEFAULT_SWITCH_POLICY.threshold).toBe(0);
  });

  it('reuses the effort-resolver band width (0.05)', () => {
    expect(HYSTERESIS_BAND).toBe(0.05);
    expect(DEFAULT_SWITCH_POLICY.band).toBe(HYSTERESIS_BAND);
  });

  it('freezes every exported table', () => {
    expect(Object.isFrozen(COST_TERMS)).toBe(true);
    expect(Object.isFrozen(BENEFIT_TERMS)).toBe(true);
    expect(Object.isFrozen(COST_TERM_UNITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SWITCH_POLICY)).toBe(true);
    expect(Object.isFrozen(SWITCH_OVERRIDES)).toBe(true);
    expect(Object.isFrozen(UNPRICED_COST_TERMS)).toBe(true);
  });

  it('lists the five §29 immediate-escalation triggers as a closed set', () => {
    expect([...SWITCH_OVERRIDES]).toEqual([
      'capability_failure',
      'critical_verification_failure',
      'security_risk',
      'architecture_contradiction',
      'user_override',
    ]);
  });
});

describe('catalog port', () => {
  it('prices per token from the injected catalog, not an import', () => {
    // opus priceInPerMTok 5 -> 5e-6 USD/token; priceOutPerMTok 25 -> 2.5e-5.
    expect(freshInputPrice(catalog, 'opus')).toBeCloseTo(5e-6, 12);
    expect(outputPrice(catalog, 'opus')).toBeCloseTo(2.5e-5, 12);
  });

  it('accepts a stub catalog, proving no hidden dependency on lib/core', () => {
    const stub = { getModel: () => ({ priceInPerMTok: 2, priceOutPerMTok: 4 }) };
    expect(freshInputPrice(stub, 'anything')).toBeCloseTo(2e-6, 12);
  });

  it('returns null for an unknown tier and for a missing port', () => {
    expect(freshInputPrice(catalog, 'nope')).toBeNull();
    expect(freshInputPrice(undefined, 'opus')).toBeNull();
    expect(outputPrice({}, 'opus')).toBeNull();
  });

  it('covers every catalog tier, so a new tier cannot price as null unnoticed', () => {
    for (const tier of Object.keys(MODELS)) {
      expect(freshInputPrice(catalog, tier)).toBeGreaterThan(0);
      expect(outputPrice(catalog, tier)).toBeGreaterThan(0);
    }
  });
});

describe('resolvePerformance', () => {
  it('reads the plain-string shape from ARTIBOT-5.0-DESIGN.md §3.2', () => {
    expect(resolvePerformance({ performance: 'maximum' })).toBe('maximum');
  });

  it('reads the {priority} object shape landed by the T-18 schema', () => {
    expect(resolvePerformance({ performance: { priority: 'split' } })).toBe('split');
  });

  it('returns null for absent, empty or wrongly typed performance', () => {
    expect(resolvePerformance({})).toBeNull();
    expect(resolvePerformance(undefined)).toBeNull();
    expect(resolvePerformance({ performance: '  ' })).toBeNull();
    expect(resolvePerformance({ performance: 42 })).toBeNull();
  });
});

describe('residencyBarrier', () => {
  it('collapses the two §30 knobs to their maximum (one counter exists)', () => {
    expect(residencyBarrier({ minimum_residency: 3, cooldown: 2 })).toBe(3);
    expect(residencyBarrier({ minimum_residency: 1, cooldown: 5 })).toBe(5);
  });

  it('falls back to the §30 defaults on missing or invalid knobs', () => {
    expect(residencyBarrier({})).toBe(3);
    expect(residencyBarrier({ minimum_residency: -1, cooldown: null })).toBe(3);
    expect(residencyBarrier(undefined)).toBe(3);
  });
});

describe('evaluateSwitch — guards (every one holds)', () => {
  it('holds with no candidate tier', () => {
    const r = evaluateSwitch({ from: 'opus', ...resident });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['no-candidate']);
  });

  it('holds when the candidate equals the incumbent, at zero measured cost', () => {
    const r = evaluateSwitch({ from: 'opus', to: 'opus', contextTokens: 500000, ...resident });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['same-tier']);
    expect(r.switchCostUsd).toBe(0);
    expect(r.cost.contextRebuild).toEqual({ value: 0, measured: true });
  });

  it('keeps the three unmeasurable terms measured:false even at a zero cost', () => {
    const r = evaluateSwitch({ from: 'opus', to: 'opus', ...resident });
    expect(r.cost.handoffLatency.measured).toBe(false);
    expect(r.cost.reorientationRisk.measured).toBe(false);
    expect(r.cost.expectedRetry.measured).toBe(false);
  });

  it('holds when the catalog cannot price a tier', () => {
    const r = evaluateSwitch({ from: 'opus', to: 'mystery', ...resident });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['catalog-miss']);
  });

  it('never throws on junk input and defaults to hold', () => {
    for (const bad of [undefined, null, {}, { to: 7 }, { from: [], to: {} }]) {
      const r = evaluateSwitch(bad);
      expect(r.hold).toBe(true);
    }
  });

  it('returns a frozen result so callers cannot mutate a recorded decision', () => {
    const r = evaluateSwitch({ from: 'opus', to: 'fable', ...resident });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.cost)).toBe(true);
    expect(Object.isFrozen(r.cost.cacheLoss)).toBe(true);
    expect(Object.isFrozen(r.reason)).toBe(true);
  });
});

describe('evaluateSwitch — §30 residency', () => {
  it('holds while actionsSinceSwitch is below the barrier', () => {
    const r = evaluateSwitch({
      from: 'opus', to: 'haiku', actionsSinceSwitch: 2, catalog,
    });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['minimum-residency']);
    expect(r.residency).toMatchObject({ barrier: 3, satisfied: false });
  });

  it('holds when the counter is absent entirely (fail closed, not fail open)', () => {
    const r = evaluateSwitch({ from: 'opus', to: 'haiku', catalog });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['minimum-residency']);
    expect(r.residency.actionsSinceSwitch).toBeNull();
  });

  it('clears the barrier at exactly the barrier count', () => {
    const r = evaluateSwitch({
      from: 'opus', to: 'haiku', actionsSinceSwitch: 3, catalog,
    });
    expect(r.residency.satisfied).toBe(true);
    expect(r.reason).not.toContain('minimum-residency');
  });

  it('reports both §30 knobs alongside the collapsed barrier', () => {
    const r = evaluateSwitch({
      from: 'opus', to: 'haiku', actionsSinceSwitch: 9, catalog,
      policy: { minimum_residency: 4, cooldown: 6 },
    });
    expect(r.residency).toMatchObject({ minimumResidency: 4, cooldown: 6, barrier: 6 });
  });
});

describe('evaluateSwitch — §28 cost terms', () => {
  const transition = {
    from: 'fable',
    to: 'opus',
    contextTokens: 100000,
    handoffTokens: 8000,
    ...resident,
  };

  it('charges the handoff payload once as output and once as input', () => {
    const r = evaluateSwitch(transition);
    expect(r.cost.contextSerialization).toEqual({ value: 8000, measured: true });
    expect(r.cost.handoffTokens).toEqual({ value: 8000, measured: true });
  });

  it('rebuilds only the context the handoff does not carry', () => {
    const r = evaluateSwitch(transition);
    expect(r.cost.contextRebuild).toEqual({ value: 92000, measured: true });
  });

  it('floors rebuild at zero when the handoff is larger than the context', () => {
    const r = evaluateSwitch({ ...transition, contextTokens: 1000, handoffTokens: 8000 });
    expect(r.cost.contextRebuild.value).toBe(0);
  });

  it('marks token terms unmeasured when the caller supplied no counts', () => {
    const r = evaluateSwitch({ from: 'fable', to: 'opus', ...resident });
    expect(r.cost.handoffTokens).toEqual({ value: 0, measured: false });
    expect(r.cost.contextRebuild).toEqual({ value: 0, measured: false });
  });

  it('holds handoffLatency, reorientationRisk and expectedRetry at 0/false (§8.2 R2)', () => {
    const r = evaluateSwitch(transition);
    expect(r.cost.handoffLatency).toEqual({ value: 0, measured: false });
    expect(r.cost.reorientationRisk).toEqual({ value: 0, measured: false });
    expect(r.cost.expectedRetry).toEqual({ value: 0, measured: false });
  });

  it('produces all seven terms with a {value, measured} shape', () => {
    const r = evaluateSwitch(transition);
    for (const key of COST_TERMS) {
      expect(Object.keys(r.cost[key]).sort()).toEqual(['measured', 'value']);
      expect(typeof r.cost[key].value).toBe('number');
      expect(typeof r.cost[key].measured).toBe('boolean');
    }
  });
});

describe('evaluateSwitch — cache loss', () => {
  it('bounds cache loss at contextTokens x freshInputPrice(to) with no receipt', () => {
    const r = evaluateSwitch({
      from: 'fable', to: 'opus', contextTokens: 100000, handoffTokens: 0, ...resident,
    });
    // 100000 tokens x 5e-6 USD/token (opus fresh input) = 0.5 USD.
    expect(r.cost.cacheLoss.value).toBeCloseTo(0.5, 9);
    expect(r.cost.cacheLoss.measured).toBe(false);
  });

  it('marks cache loss measured only for a receipt-sourced cache read', () => {
    const r = evaluateSwitch({
      from: 'fable',
      to: 'opus',
      contextTokens: 100000,
      cacheReadTokens: 40000,
      usageSource: 'transcript',
      ...resident,
    });
    expect(r.cost.cacheLoss.value).toBeCloseTo(0.2, 9);
    expect(r.cost.cacheLoss.measured).toBe(true);
  });

  it('leaves cache loss unmeasured when the source is an estimate', () => {
    const r = evaluateSwitch({
      from: 'fable', to: 'opus', cacheReadTokens: 40000, usageSource: 'estimate', ...resident,
    });
    expect(r.cost.cacheLoss.measured).toBe(false);
  });

  it('leaves cache loss unmeasured when a receipt source carries no cache read', () => {
    const r = evaluateSwitch({
      from: 'fable', to: 'opus', contextTokens: 1000, usageSource: 'transcript', ...resident,
    });
    expect(r.cost.cacheLoss.measured).toBe(false);
  });

  it('falls back to cacheCreation totals before the whole-context bound', () => {
    const r = evaluateSwitch({
      from: 'fable',
      to: 'opus',
      contextTokens: 100000,
      cacheCreation: { '1h': 10000, '5m': 5000 },
      ...resident,
    });
    // 15000 x 5e-6 = 0.075 — the creation total, not the 100000 context bound.
    expect(r.cost.cacheLoss.value).toBeCloseTo(0.075, 9);
    expect(r.cost.cacheLoss.measured).toBe(false);
  });

  it('accepts only the transcript and otlp sources as measurements', () => {
    expect([...MEASURED_USAGE_SOURCES]).toEqual(['transcript', 'otlp']);
  });
});

describe('evaluateSwitch — utility', () => {
  it('sums the priced terms in USD and subtracts them from benefit', () => {
    const r = evaluateSwitch({
      from: 'fable',
      to: 'opus',
      contextTokens: 10000,
      handoffTokens: 2000,
      ...resident,
    });
    // serialization 2000 x 5e-5 (fable out) = 0.10
    // rebuild      8000 x 5e-6 (opus in)   = 0.04
    // cacheLoss   10000 x 5e-6             = 0.05
    // handoff      2000 x 5e-6             = 0.01
    expect(r.switchCostUsd).toBeCloseTo(0.2, 9);
    expect(r.switchBenefitUsd).toBe(0);
    expect(r.switchUtility).toBeCloseTo(-0.2, 9);
  });

  it('excludes the two unpriced terms from the sum by name', () => {
    expect([...UNPRICED_COST_TERMS]).toEqual(['handoffLatency', 'reorientationRisk']);
  });

  it('prices the from-side at zero when there is no incumbent model', () => {
    const r = evaluateSwitch({ from: null, to: 'opus', handoffTokens: 2000, ...resident });
    // Only the to-side input charge applies: 2000 x 5e-6 = 0.01.
    expect(r.switchCostUsd).toBeCloseTo(0.01, 9);
  });
});

describe('evaluateSwitch — benefit', () => {
  it('passes caller-asserted gains through, all measured:false', () => {
    const r = evaluateSwitch({
      from: 'opus', to: 'fable',
      expectedGain: { quality: 1.5, latency: 0.25, failure: 0.75 },
      ...resident,
    });
    expect(r.benefit.quality).toEqual({ value: 1.5, measured: false });
    expect(r.benefit.latency).toEqual({ value: 0.25, measured: false });
    expect(r.benefit.failure).toEqual({ value: 0.75, measured: false });
  });

  it('projects future cost saving from the price delta under balanced', () => {
    const r = evaluateSwitch({
      from: 'fable',
      to: 'opus',
      expectedRemainingTokens: 200000,
      profile: { performance: 'balanced' },
      ...resident,
    });
    // 200000 x (1e-5 fable - 5e-6 opus) = 1.0 USD saved.
    expect(r.benefit.futureCost.value).toBeCloseTo(1, 9);
    expect(r.benefit.futureCost.measured).toBe(false);
  });

  it('zeroes cost saving under maximum and split (§4.3 CostEfficiency 0)', () => {
    for (const performance of ['maximum', 'split']) {
      const r = evaluateSwitch({
        from: 'fable', to: 'opus', expectedRemainingTokens: 200000,
        profile: { performance }, ...resident,
      });
      expect(r.benefit.futureCost.value).toBe(0);
    }
  });

  it('zeroes cost saving for the {priority} profile shape too', () => {
    const r = evaluateSwitch({
      from: 'fable', to: 'opus', expectedRemainingTokens: 200000,
      profile: { performance: { priority: 'maximum' } }, ...resident,
    });
    expect(r.benefit.futureCost.value).toBe(0);
  });

  it('weights cost saving when no profile is supplied (balanced is the default)', () => {
    const r = evaluateSwitch({
      from: 'fable', to: 'opus', expectedRemainingTokens: 200000, ...resident,
    });
    expect(r.benefit.futureCost.value).toBeCloseTo(1, 9);
  });
});

describe('execution-profile directives (T-26) as an injected port', () => {
  const base = {
    from: 'fable', to: 'opus', expectedRemainingTokens: 200000, ...resident,
  };

  it('takes costWeight from the directives rather than re-deciding', () => {
    expect(PERFORMANCE_DIRECTIVES.split.costWeight).toBe(0);
    const r = evaluateSwitch({ ...base, directives: PERFORMANCE_DIRECTIVES.split });
    expect(r.benefit.futureCost.value).toBe(0);
  });

  it('lets a directive override a contradicting profile, so the two cannot drift', () => {
    const r = evaluateSwitch({
      ...base,
      profile: { performance: 'maximum' },
      directives: PERFORMANCE_DIRECTIVES.balanced,
    });
    expect(r.benefit.futureCost.value).toBeCloseTo(1, 9);
  });

  it('agrees with every directive in the T-26 table', () => {
    for (const [priority, directives] of Object.entries(PERFORMANCE_DIRECTIVES)) {
      const viaDirectives = evaluateSwitch({ ...base, directives });
      const viaProfile = evaluateSwitch({ ...base, profile: { performance: priority } });
      expect(viaDirectives.benefit.futureCost.value)
        .toBeCloseTo(viaProfile.benefit.futureCost.value, 9);
    }
  });

  it('clamps a weight above 1 and ignores a negative one', () => {
    expect(resolveCostWeight({ directives: { costWeight: 5 } })).toBe(1);
    expect(resolveCostWeight({ directives: { costWeight: -1 } })).toBe(1);
  });

  it('falls back to the profile allowlist with no directives', () => {
    expect(resolveCostWeight({ profile: { performance: 'balanced' } })).toBe(1);
    expect(resolveCostWeight({ profile: { performance: 'maximum' } })).toBe(0);
    expect(resolveCostWeight({})).toBe(1);
  });
});

describe('evaluateSwitch — threshold and the ±band', () => {
  /** Zero-cost transition, so utility is exactly the asserted quality gain. */
  const noCost = { from: 'opus', to: 'fable', handoffTokens: 0, contextTokens: 0, ...resident };

  it('switches when utility clears the threshold by more than the band', () => {
    const r = evaluateSwitch({ ...noCost, expectedGain: { quality: 0.2 } });
    expect(r.switchUtility).toBeCloseTo(0.2, 9);
    expect(r.hold).toBe(false);
    expect(r.reason).toEqual(['above-threshold']);
  });

  it('holds inside the band on the favourable side (no flap)', () => {
    const r = evaluateSwitch({ ...noCost, expectedGain: { quality: 0.04 } });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['hysteresis-band']);
  });

  it('holds exactly at the band edge', () => {
    const r = evaluateSwitch({ ...noCost, expectedGain: { quality: 0.05 } });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['hysteresis-band']);
  });

  it('holds below the threshold outside the band', () => {
    const r = evaluateSwitch({ ...noCost, expectedGain: { quality: 0 }, contextTokens: 100000 });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['below-threshold']);
  });

  it('honours a caller-supplied threshold and band width', () => {
    const r = evaluateSwitch({
      ...noCost,
      expectedGain: { quality: 0.2 },
      policy: { threshold: 0.5, band: 0.4 },
    });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['hysteresis-band']);
    expect(r.threshold).toBe(0.5);
  });
});

describe('evaluateSwitch — §29 immediate escalation overrides', () => {
  it('bypasses residency and the band for every allowlisted trigger', () => {
    for (const override of SWITCH_OVERRIDES) {
      const r = evaluateSwitch({
        from: 'opus', to: 'fable', actionsSinceSwitch: 0, contextTokens: 500000,
        catalog, override,
      });
      expect(r.hold).toBe(false);
      expect(r.reason).toEqual([`override:${override}`]);
    }
  });

  it('ignores an unlisted override, so a new trigger fails closed', () => {
    const r = evaluateSwitch({
      from: 'opus', to: 'fable', actionsSinceSwitch: 0, catalog, override: 'because_i_said_so',
    });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['minimum-residency']);
  });

  it('does not let an override switch to an unpriceable tier', () => {
    const r = evaluateSwitch({
      from: 'opus', to: 'mystery', catalog, override: 'user_override',
    });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['catalog-miss']);
  });

  it('does not let an override switch to the tier already in use', () => {
    const r = evaluateSwitch({
      from: 'opus', to: 'opus', catalog, override: 'user_override',
    });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['same-tier']);
  });
});

describe('receipt projection (lane 2 §4.5)', () => {
  it('yields cost keys assignable to route-receipt terms{} with no renaming', () => {
    const r = evaluateSwitch({
      from: 'fable', to: 'opus', contextTokens: 100000, handoffTokens: 8000, ...resident,
    });
    // The receipt schema's terms{} required list, verbatim.
    expect(Object.keys(r.cost).sort()).toEqual([
      'cacheLoss',
      'contextRebuild',
      'contextSerialization',
      'expectedRetry',
      'handoffLatency',
      'handoffTokens',
      'reorientationRisk',
    ]);
  });

  it('keeps the two token terms integral, as transition{} requires integers', () => {
    const r = evaluateSwitch({
      from: 'fable', to: 'opus', contextTokens: 100000, handoffTokens: 8000, ...resident,
    });
    expect(Number.isInteger(r.cost.contextRebuild.value)).toBe(true);
    expect(Number.isInteger(r.cost.handoffTokens.value)).toBe(true);
  });

  it('keeps cache loss non-negative, as cache_loss_estimate requires', () => {
    const r = evaluateSwitch({
      from: 'haiku', to: 'fable', contextTokens: 50000, ...resident,
    });
    expect(r.cost.cacheLoss.value).toBeGreaterThanOrEqual(0);
  });
});
