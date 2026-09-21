/**
 * Stem-matched pin for `lib/routing/adaptive-model-router.js` (Stop gate rule:
 * `<stem>.test.js`; the broader behavioural suite lives in `adaptive-router.test.js`).
 *
 * Pins the incumbent contract documented on `routeModel({ currentTier })`
 * (2026-09-15 wording): `models.current` is an identity only when the tier can be
 * evidenced through the catalog by exact id match; every unreadable or unknown
 * source yields `null`, which is NOT "no switch happened".
 *
 * Also pins the GA-02 canary allowlist gate (`input.canary.actionClasses`):
 * nothing in the repo fills that list, so the only thing these tests can prove
 * is the MECHANISM — that an unmatched list leaves the receipt byte-identical
 * to today's, and that a matched one moves `models.selected` onto the tier
 * `pickRoute` already chose while `policy:` still records the counterfactual.
 * They say nothing about whether a canary ever fires in production.
 *
 * @module tests/routing/adaptive-model-router.test
 */

import { describe, expect, it } from 'vitest';
import {
  modelIdentity,
  resolveCanaryClasses,
  resolveCandidateTiers,
  routeModel,
  ROUTER_DECISIONS,
} from '../../lib/routing/adaptive-model-router.js';
import { MODELS } from '../../lib/core/model-catalog.js';
import { ACTION_CLASSES } from '../../lib/routing/action-classifier.js';
import { DEFAULT_CATALOG } from '../../lib/routing/route-scorer.js';

/**
 * Explicit policy fixture, mirroring `adaptive-router.test.js`: `architect` is
 * fable-allowlisted so the recommendation (fable) diverges from what
 * `resolveModel` answers for the build role (opus). No assertion below may
 * depend on the repo's live `artibot.config.json`.
 */
const CONFIG = Object.freeze({
  agents: {
    modelPolicy: {
      fable: { enabled: true, allowlist: ['architect'] },
      high: { model: 'opus', agents: ['architect', 'backend-developer'] },
      medium: { model: 'opus', agents: [] },
      phaseRoles: { build: 'opus', review: 'fable' },
    },
  },
});

/** Identity a caller must supply; fixed so two receipts compare by value. */
const EVIDENCE = Object.freeze({
  route_receipt_id: 'rr-1',
  mission_id: 'mission-1',
  session_id: 'session-1',
  execution_profile_version: 1,
  timestamp: '2026-09-02T00:00:00.000Z',
  shadow_of: 'seq-42',
});

/**
 * A fully-specified, deterministic routing input.
 *
 * @param {object} [over] - Overrides merged over the base.
 * @returns {object} Router input.
 */
function canaryInput(over = {}) {
  return {
    agentType: 'architect',
    role: 'build',
    actionClass: 'architecture',
    input: { text: 'design the module boundary', phase: 'build' },
    config: CONFIG,
    catalog: DEFAULT_CATALOG,
    currentTier: 'opus',
    actionsSinceSwitch: 9,
    epoch: 'run-1',
    evidence: EVIDENCE,
    ...over,
  };
}

describe('adaptive-model-router — incumbent identity contract', () => {
  it('resolves a known tier to the catalog id (exact match, no aliasing)', () => {
    for (const tier of ['opus', 'fable', 'sonnet', 'haiku']) {
      const identity = modelIdentity(tier, undefined);
      expect(identity).not.toBeNull();
      expect(identity.tier).toBe(tier);
      expect(identity.model_id).toBe(MODELS[tier].id);
    }
  });

  it('yields null for every source that cannot be evidenced (absent, blank, non-string, unknown tier)', () => {
    for (const source of [undefined, null, '', '   ', 42, {}, 'claude-sonnet-4-6', 'opus[1m]']) {
      expect(modelIdentity(source, undefined)).toBeNull();
    }
  });

  it('exposes exactly the two decision types the receipt schema allows', () => {
    expect([...ROUTER_DECISIONS]).toEqual(['route', 'pin']);
    expect(Object.isFrozen(ROUTER_DECISIONS)).toBe(true);
  });
});

describe('resolveCanaryClasses — fail-closed normalisation', () => {
  it('yields an empty list for every shape that is not an array of classes', () => {
    for (const canary of [undefined, null, 42, 'architecture', [], { actionClasses: undefined }]) {
      expect(resolveCanaryClasses(canary)).toEqual([]);
    }
    for (const actionClasses of [undefined, null, 42, 'architecture', new Set(['architecture'])]) {
      expect(resolveCanaryClasses({ actionClasses })).toEqual([]);
    }
  });

  it('drops the WHOLE list when any member is unusable — never applies partially', () => {
    const bad = [
      ['architecture', 42],
      ['architecture', ''],
      ['architecture', '   '],
      ['architecture', null],
      ['architecture', {}],
      [{}],
    ];
    for (const actionClasses of bad) {
      expect(resolveCanaryClasses({ actionClasses })).toEqual([]);
    }
  });

  it('passes a clean list through unchanged', () => {
    // Both names are real ACTION_CLASSES members. The helper does NOT check
    // membership (a typo is silently unmatched), but using real names here
    // keeps the fixture from implying an unchecked vocabulary is intended.
    expect(resolveCanaryClasses({ actionClasses: ['architecture', 'implement'] }))
      .toEqual(['architecture', 'implement']);
  });

  it('does not validate members against the action-class vocabulary', () => {
    // Documented, deliberate: membership is not checked, so 'implementation'
    // (the plausible typo for 'implement') normalises fine and then matches
    // nothing. Fail-closed, but silent — see resolveSelection precondition 4.
    expect(ACTION_CLASSES).not.toContain('implementation');
    expect(resolveCanaryClasses({ actionClasses: ['implementation'] }))
      .toEqual(['implementation']);
  });

  it('never throws on a hostile carrier', () => {
    const throwingCarrier = { get actionClasses() { throw new Error('hostile'); } };
    const throwingMember = { actionClasses: [{ get length() { throw new Error('hostile'); } }] };
    expect(resolveCanaryClasses(throwingCarrier)).toEqual([]);
    expect(resolveCanaryClasses(throwingMember)).toEqual([]);
  });
});

describe('canary allowlist gate — unmatched is inert', () => {
  const inert = [
    undefined,
    { actionClasses: [] },
    { actionClasses: ['implementation', 'review'] },
    { actionClasses: ['architecture', 42] },
    { actionClasses: 'architecture' },
    null,
  ];
  const inputs = [
    canaryInput(),
    canaryInput({ currentTier: undefined }),
    canaryInput({ role: 'review' }),
    canaryInput({ allowedTiers: [] }),
  ];

  it('leaves the receipt identical to today\'s for every unmatched carrier', () => {
    for (const input of inputs) {
      // JSON.stringify, not toEqual: the contract is byte-identity, which
      // includes KEY ORDER, and toEqual is order-blind.
      const baseline = JSON.stringify(routeModel(input));
      for (const canary of inert) {
        expect(JSON.stringify(routeModel({ ...input, canary }))).toBe(baseline);
      }
    }
  });

  it('the baseline it compares against really does carry a divergence', () => {
    // Without this the inertness assertion above could pass on a receipt where
    // recommendation and policy agree, i.e. where a leak would be invisible.
    const baseline = routeModel(canaryInput());
    expect(baseline.reason).toContain('divergence');
    expect(baseline.models.recommended.tier).toBe('fable');
    expect(baseline.models.selected.tier).toBe('opus');
    expect(baseline.reason.some((code) => code.startsWith('canary:'))).toBe(false);
  });
});

describe('canary allowlist gate — matched moves the seat, not the vocabulary', () => {
  const canary = { actionClasses: ['architecture'] };

  it('selects the recommended tier while policy: still records the counterfactual', () => {
    const unmatched = routeModel(canaryInput());
    const matched = routeModel(canaryInput({ canary }));
    expect(matched.models.selected.tier).toBe(matched.models.recommended.tier);
    expect(matched.models.selected.tier).toBe('fable');
    expect(matched.reason).toContain('policy:opus');
    expect(matched.reason).toContain('canary:fable');
    expect(matched.reason.indexOf('canary:fable'))
      .toBeGreaterThan(matched.reason.indexOf('divergence'));
    expect(ROUTER_DECISIONS).toContain(matched.decision.type);
    expect(matched.decision.type).toBe('route');
    expect(Object.keys(matched)).toEqual(Object.keys(unmatched));
  });

  it('pins when the incumbent already holds the canary seat', () => {
    const matched = routeModel(canaryInput({ canary, currentTier: 'fable' }));
    expect(matched.models.selected.tier).toBe('fable');
    expect(matched.decision.type).toBe('pin');
  });

  it('still records canary: when recommendation and policy already agree', () => {
    // CHOICE: the gate DID apply, so its reason code is emitted even though the
    // seat does not move — otherwise a silent no-op is indistinguishable from
    // an allowlist that never matched, and the two have different meanings.
    const matched = routeModel(canaryInput({ canary, allowedTiers: ['opus'] }));
    expect(matched.models.recommended.tier).toBe('opus');
    expect(matched.models.selected.tier).toBe('opus');
    expect(matched.reason).toContain('policy:opus');
    expect(matched.reason).toContain('canary:opus');
    expect(matched.reason).not.toContain('divergence');
  });

  it('stays inert when nothing was scorable, even on a matching class', () => {
    const noCandidate = canaryInput({ allowedTiers: ['haiku'], canary });
    const receipt = routeModel(noCandidate);
    expect(receipt.models.recommended).toBeNull();
    expect(receipt.reason).toContain('route:no-candidate');
    expect(receipt.reason.some((code) => code.startsWith('canary:'))).toBe(false);
    expect(receipt).toEqual(routeModel({ ...noCandidate, canary: undefined }));
  });

  it('never throws on a hostile canary value', () => {
    const hostile = [
      null, 42, 'architecture', [], [{}],
      { actionClasses: [{}] },
      { get actionClasses() { throw new Error('hostile'); } },
    ];
    for (const value of hostile) {
      expect(() => routeModel(canaryInput({ canary: value }))).not.toThrow();
    }
  });

  it('never throws when the INPUT OBJECT itself throws on the canary read', () => {
    // The carrier is caller-supplied, so the property access is as hostile as
    // the value. Without readCanary() this getter escapes through routeModel,
    // which promises never to throw (:443-446 wording).
    const src = canaryInput();
    Object.defineProperty(src, 'canary', {
      get() { throw new Error('hostile getter'); },
      enumerable: true,
    });
    expect(() => routeModel(src)).not.toThrow();
    expect(routeModel(src).reason.some((code) => code.startsWith('canary:'))).toBe(false);
  });

  it('changes nothing outside models.selected, reason and decision', () => {
    const unmatched = routeModel(canaryInput());
    const matched = routeModel(canaryInput({ canary }));
    const volatile = new Set(['models', 'reason', 'decision']);
    for (const key of Object.keys(unmatched)) {
      if (volatile.has(key)) continue;
      expect(matched[key]).toEqual(unmatched[key]);
    }
    // Inside models, only `selected` moves.
    expect(matched.models.current).toEqual(unmatched.models.current);
    expect(matched.models.recommended).toEqual(unmatched.models.recommended);
    expect(matched.models.selected).not.toEqual(unmatched.models.selected);
    // And reason differs only by the appended canary entry.
    expect(matched.reason.filter((code) => !code.startsWith('canary:')))
      .toEqual(unmatched.reason);
  });
});

describe('canary allowlist gate — the policy ceiling still binds', () => {
  /**
   * `security-reviewer` is deliberately placed IN `fable.allowlist` here. It is
   * also in `model-policy.js#FABLE_DENYLIST` (permanent opus, refusal
   * false-positives), and the denylist must win even when a canary matches —
   * otherwise one config key would buy an agent a tier the policy forbids.
   */
  const DENYLIST_CONFIG = Object.freeze({
    agents: {
      modelPolicy: {
        fable: { enabled: true, allowlist: ['architect', 'security-reviewer'] },
        high: { model: 'opus', agents: ['architect', 'security-reviewer'] },
        medium: { model: 'opus', agents: [] },
        phaseRoles: { build: 'opus', review: 'fable' },
      },
    },
  });

  it('cannot hand a FABLE_DENYLIST agent the fable seat', () => {
    const src = canaryInput({
      agentType: 'security-reviewer',
      role: 'review',
      actionClass: 'review',
      config: DENYLIST_CONFIG,
      canary: { actionClasses: ['review'] },
    });
    expect([...resolveCandidateTiers(src)]).toEqual(['opus']);
    expect(routeModel(src).models.selected.tier).toBe('opus');
  });

  it('only ever selects a tier that is already a candidate', () => {
    // The general form of the property above: the gate picks among the tiers
    // pickRoute scored, and pickRoute scores only resolveCandidateTiers(src).
    const cases = [
      canaryInput({ canary: { actionClasses: ['architecture'] } }),
      canaryInput({ role: 'review', actionClass: 'classify', canary: { actionClasses: ['classify'] } }),
      canaryInput({ allowedTiers: ['opus'], canary: { actionClasses: ['architecture'] } }),
      canaryInput({
        agentType: 'security-reviewer',
        actionClass: 'review',
        config: DENYLIST_CONFIG,
        canary: { actionClasses: ['review'] },
      }),
    ];
    for (const src of cases) {
      const receipt = routeModel(src);
      expect([...resolveCandidateTiers(src)]).toContain(receipt.models.selected.tier);
    }
  });
});
