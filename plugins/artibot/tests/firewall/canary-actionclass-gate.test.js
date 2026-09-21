/**
 * Firewall — the GA-02 canary allowlist (`input.canary.actionClasses`) is
 * SHIPPED EMPTY, and an empty list changes nothing.
 *
 * ── Why a firewall file ────────────────────────────────────────────────────
 *  `lib/routing/adaptive-model-router.js#resolveCanaryClasses` is the only
 *  thing that can move `models.selected` off the `resolveModel` answer. Phase 0
 *  is observe-only, so the shipped allowlist is `[]` and the mechanism must be
 *  provably inert. `tests/routing/adaptive-model-router.test.js` pins the
 *  helper's semantics on a handful of inputs; this file pins the SYSTEM
 *  property — across a fixture table spanning the action-class vocabulary, both
 *  roles and both incumbent states, the receipt is BYTE-identical with and
 *  without an empty (or unusable) allowlist.
 *
 * ── What it guards ─────────────────────────────────────────────────────────
 *  A. Empty list is inert, byte-for-byte (key order included — hence
 *     `JSON.stringify`, not `toEqual`, which is order-blind).
 *  B. A NON-empty list really does move the seat, so A is not vacuous: a
 *     matched class selects the recommended tier while `policy:` still records
 *     the counterfactual.
 *  C. An unusable list (non-array, non-string members) collapses to the empty
 *     list — fail-closed, never partially applied.
 *  D. The SHIPPED `artibot.config.json` still declares `routing.canary
 *     .actionClasses: []`. This DUPLICATES `v5-config-firewall.test.js`
 *     ("routing.canary.actionClasses 는 빈 배열이다") on purpose: that file owns
 *     the six new top-level config keys as a group, this one owns the canary
 *     mechanism end to end, and the two must not be able to drift apart
 *     silently. The file is read with `fs`, never through a loader that merges
 *     defaults — the pin is about what ships, not about an effective value.
 *  E. A MATCHED receipt is still a WRITABLE ledger line. Validated through the
 *     PRODUCTION gate `lib/runtime/event-writer.js#validateEventContract`, the
 *     one the writer itself runs (it resolves the allowlist's
 *     `data_schema: route-receipt.schema.json` and then checks the receipt's
 *     identity against the envelope) — not a test-local ajv instance, because
 *     what matters is whether the real writer would accept the line. A gate
 *     that fires but produces an unappendable receipt would lose the very
 *     evidence the canary exists to collect.
 *
 * ── What this gate CANNOT see (rules §9) ───────────────────────────────────
 *  1. **User-level overrides.** D reads the repo file only. A user config, an
 *     env var, or any future merge layer can present a non-empty list to the
 *     runtime with this file still green.
 *  2. **The writer.** `scripts/hooks/route-observe-pre.js#buildReceipt` — the
 *     site of that file's `routeModel` call, reached from `#observePre` — DOES
 *     forward `config.routing.canary` into `routeModel` (measured 2026-09-21),
 *     so the carrier is live — what keeps the mechanism inert is D, the empty
 *     LIST, not the absence of a caller. The day that list is filled, A and C
 *     keep passing while the property they assert stops being interesting:
 *     inertness would then depend on the config value, and only D watches it.
 *  3. **Application.** Even a matched canary only changes a RECEIPT. Nothing
 *     applies `models.selected` to an actual spawn — `routeModel` is an
 *     observer and the route-observe hook appends a shadow line beside the
 *     production one. "The gate fired" is not "a different model ran".
 *  4. **Calibration.** Every `recommended` tier below is an opinion of the
 *     uncalibrated `route-scorer.js` tables. B proves the seat MOVED, never
 *     that it moved somewhere better.
 *  5. **What a matched receipt means to its readers.** E proves a matched
 *     receipt is WRITABLE, never that it is read correctly. Consumers that
 *     treat `models.selected` as "what ran" — `lib/scorecard/routing-scorecard
 *     .js` (`routing.recommendation_divergence`, `routing.avoided_switch`,
 *     `routing.selected_tiers`) and the `scripts/bench/routebench-corpus.mjs`
 *     baseline — would read divergence as zero under a matched canary, because
 *     recommended and selected are equal by construction and the policy answer
 *     survives only in `reason`. Nothing here tests those consumers.
 *  6. **The rest of the write path.** Case E runs exactly two steps,
 *     `validateEnvelope` + `validateEventContract`. It does NOT run the
 *     writer's secret redaction (`redactDeep`, from
 *     `lib/runtime/ledger-redaction.js`), its declared-enum normalisation
 *     (`normalizeDeclaredEnums` / `foldDeclaredEnums`), or the per-line byte
 *     cap enforced by `appendWithinCap` against `maxLineBytes`
 *     (`DEFAULT_LINE_MAX_BYTES` = 4096, overridable via `getLedgerSettings`).
 *     "The validator accepts it" is therefore narrower than "the writer
 *     appends it": an oversized line is refused (or folded) after this point.
 *
 * @module tests/firewall/canary-actionclass-gate.test
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ACTION_CLASSES } from '../../lib/routing/action-classifier.js';
import { routeModel } from '../../lib/routing/adaptive-model-router.js';
import { validateEnvelope, validateEventContract } from '../../lib/runtime/event-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '../../artibot.config.json');

/**
 * Explicit policy fixture, mirroring `tests/routing/adaptive-router.test.js`:
 * `architect` is fable-allowlisted, `backend-developer` is not. A and C are
 * properties of the MECHANISM, so they must not turn red when someone edits
 * the repo's live policy config — D is the assertion that watches that file.
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

/** Fixed identity, so two receipts of the same input compare byte-for-byte. */
const EVIDENCE = Object.freeze({
  route_receipt_id: 'rr-1',
  mission_id: 'mission-1',
  session_id: 'session-1',
  execution_profile_version: 1,
  timestamp: '2026-09-02T00:00:00.000Z',
  shadow_of: 'seq-42',
});

/**
 * Build one deterministic routing input.
 *
 * @param {object} over - Overrides merged over the base.
 * @returns {object} Router input.
 */
function input(over) {
  return {
    agentType: 'architect',
    config: CONFIG,
    actionsSinceSwitch: 9,
    epoch: 'run-1',
    evidence: EVIDENCE,
    ...over,
  };
}

/**
 * The fixture table. `architect` + `review` is the corner where the scorer's
 * pick and `phaseRoles.review` disagree for the six non-fable classes, which
 * is what supplies the divergent rows (measured 2026-09-21).
 */
const FIXTURES = Object.freeze([
  input({ actionClass: 'classify', role: 'review', currentTier: 'opus' }),
  input({ actionClass: 'status', role: 'review', currentTier: undefined }),
  input({ actionClass: 'explore', role: 'review', currentTier: 'fable' }),
  input({ actionClass: 'edit-routine', role: 'build', currentTier: 'opus' }),
  input({ actionClass: 'implement', role: 'build', currentTier: undefined }),
  input({ actionClass: 'complex-debug', role: 'build', currentTier: 'haiku' }),
  input({ actionClass: 'architecture', role: 'build', currentTier: 'opus' }),
  input({ actionClass: 'review', role: 'review', currentTier: 'fable' }),
  input({ actionClass: 'architecture', role: 'review', currentTier: undefined }),
  input({ agentType: 'backend-developer', actionClass: 'implement', role: 'build' }),
  input({ agentType: 'backend-developer', actionClass: 'review', role: 'review' }),
  input({ agentType: undefined, actionClass: 'explore', currentTier: 'sonnet' }),
  input({ actionClass: 'classify', role: 'build', currentTier: undefined }),
  input({ actionClass: 'implement', role: 'review', currentTier: 'opus', allowedTiers: [] }),
]);

/** Carriers that must all normalise to the empty list. */
const UNUSABLE = Object.freeze([
  undefined,
  null,
  42,
  'classify',
  [],
  { actionClasses: undefined },
  { actionClasses: null },
  { actionClasses: 'classify' },
  { actionClasses: new Set(['classify']) },
  { actionClasses: ['classify', 42] },
  { actionClasses: ['classify', ''] },
  { actionClasses: ['classify', null] },
  { actionClasses: [{}] },
]);

/**
 * @param {object} x - Router input.
 * @returns {string} Canonical receipt text; equality here is byte-identity.
 */
function receipt(x) {
  return JSON.stringify(routeModel(x));
}

describe('canary action-class gate — self-check (the gate must not go falsely green)', () => {
  it('the fixture table is large and varied enough for inertness to mean something', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(12);
    const classes = new Set(FIXTURES.map((x) => x.actionClass));
    expect(classes.size).toBeGreaterThanOrEqual(6);
    for (const actionClass of classes) expect(ACTION_CLASSES).toContain(actionClass);
    expect(new Set(FIXTURES.map((x) => x.role))).toEqual(new Set(['build', 'review', undefined]));
    expect(FIXTURES.some((x) => x.currentTier !== undefined)).toBe(true);
    expect(FIXTURES.some((x) => x.currentTier === undefined)).toBe(true);
  });

  it('at least three baseline receipts actually diverge, so a leak would be visible', () => {
    // Without a divergence there is nothing for a leaking canary to move the
    // seat TO, and every byte-identity assertion below would hold vacuously.
    const divergent = FIXTURES.filter((x) => routeModel(x).reason.includes('divergence'));
    expect(divergent.length).toBeGreaterThanOrEqual(3);
  });
});

describe('canary action-class gate — an empty or unusable allowlist is inert', () => {
  it('leaves every fixture receipt byte-identical under an empty list', () => {
    for (const x of FIXTURES) {
      expect(receipt({ ...x, canary: { actionClasses: [] } })).toBe(receipt(x));
    }
  });

  it('leaves every fixture receipt byte-identical under every unusable carrier', () => {
    for (const x of FIXTURES) {
      const baseline = receipt(x);
      for (const canary of UNUSABLE) {
        expect(receipt({ ...x, canary })).toBe(baseline);
      }
    }
  });

  it('is inert for a well-formed list that names no class this action belongs to', () => {
    const canary = { actionClasses: ['__no_such_class__'] };
    for (const x of FIXTURES) {
      expect(receipt({ ...x, canary })).toBe(receipt(x));
    }
  });
});

describe('canary action-class gate — a matched class moves the seat', () => {
  const canary = Object.freeze({ actionClasses: ['classify'] });
  const matchedInput = input({ actionClass: 'classify', role: 'review', currentTier: 'opus' });

  it('the matched fixture really does diverge, or "the seat moved" proves nothing', () => {
    const baseline = routeModel(matchedInput);
    expect(baseline.models.recommended.tier).toBe('opus');
    expect(baseline.models.selected.tier).toBe('fable');
    expect(baseline.models.recommended.tier).not.toBe(baseline.models.selected.tier);
  });

  it('selects the recommended tier while policy: still records the counterfactual', () => {
    const matched = routeModel({ ...matchedInput, canary });
    expect(matched.models.selected.tier).toBe(matched.models.recommended.tier);
    expect(matched.models.selected.tier).toBe('opus');
    expect(matched.reason).toContain('policy:fable');
    expect(matched.reason).toContain('canary:opus');
    expect(Object.keys(matched)).toEqual(Object.keys(routeModel(matchedInput)));
  });

  it('does not touch an action of a class the same list does not name', () => {
    const other = input({ actionClass: 'status', role: 'review', currentTier: 'opus' });
    expect(receipt({ ...other, canary })).toBe(receipt(other));
  });
});

describe('canary action-class gate — the shipped config declares an empty list', () => {
  // Deliberate duplicate of v5-config-firewall.test.js: that file owns the six
  // new top-level keys as a group, this one owns the canary mechanism, and the
  // two must not drift apart without one of them going red.
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));

  it('routing.canary.actionClasses ships as an empty array', () => {
    expect(Array.isArray(config.routing.canary.actionClasses)).toBe(true);
    expect(config.routing.canary.actionClasses).toEqual([]);
  });
});

describe('canary action-class gate — a matched receipt is still appendable', () => {
  const MISSION = 'M-20260921-S1234abcd';
  const SESSION = 'session-canary-1';
  const TS = '2026-09-21T00:00:00.000Z';
  const EPOCH = 'toolu_canary_epoch_1';

  /** A matched receipt with every schema-required field actually sourced. */
  const matchedInput = {
    agentType: 'architect',
    role: 'review',
    actionClass: 'classify',
    input: { text: 'classify this action', phase: 'review' },
    classifierOptions: {
      classifyComplexity: () => ({ score: 0.7, factors: { uncertainty: 0.4, risk: 0.2 } }),
    },
    config: CONFIG,
    currentTier: 'opus',
    actionsSinceSwitch: 9,
    epoch: EPOCH,
    evidence: {
      route_receipt_id: 'rr-canary-1',
      mission_id: MISSION,
      session_id: SESSION,
      execution_profile_version: 1,
      timestamp: TS,
      shadow_of: 'tool_use:toolu_x',
    },
    canary: { actionClasses: ['classify'] },
  };

  /**
   * @param {object} data - Receipt to carry.
   * @returns {object} A `route.selected` envelope the writer would accept.
   */
  function envelope(data) {
    return {
      v: 1,
      ts: TS,
      event: 'route.selected',
      session_id: SESSION,
      source: 'hook',
      pid: 1234,
      seq: 1,
      mission_id: MISSION,
      routing_epoch_id: EPOCH,
      data,
    };
  }

  it('the fixture really is matched, or this proves nothing about the canary', () => {
    const matched = routeModel(matchedInput);
    expect(matched.reason).toContain('canary:opus');
    expect(matched.models.selected.tier).toBe('opus');
  });

  it('passes the production ledger validator with zero rejections', () => {
    const matched = routeModel(matchedInput);
    // null === accepted; anything else is the writer's rejection reason.
    expect(validateEnvelope(envelope(matched))).toBeNull();
    expect(validateEventContract(envelope(matched))).toBeNull();
  });

  it('rejects the shapes this limb deliberately did NOT build', () => {
    // NEGATIVE CONTROL for case E: a validator that accepts everything would
    // make E meaningless. These two shapes are the limb brief's ORIGINAL
    // design — a sixth `decision.type` value `canary`, and a root-level
    // `canary` block on the receipt. Both were withdrawn because the schema
    // closes `decision.type` to five values and sets `additionalProperties`
    // false at the root; the gate was built inside the existing vocabulary
    // instead. If either of these were accepted, that history would be wrong.
    const matched = routeModel(matchedInput);

    const sixthType = { ...matched, decision: { ...matched.decision, type: 'canary' } };
    expect(validateEventContract(envelope(sixthType))).not.toBeNull();

    const rootKey = { ...matched, canary: { enabled: true, matched: true } };
    expect(validateEventContract(envelope(rootKey))).not.toBeNull();

    // ...and the untouched original still passes, so the rejections above are
    // about the mutations and not about the fixture.
    expect(validateEventContract(envelope(matched))).toBeNull();
  });

  it('orders the reason codes policy -> divergence -> canary', () => {
    const reason = routeModel(matchedInput).reason;
    const policy = reason.indexOf('policy:fable');
    const divergence = reason.indexOf('divergence');
    const canaryAt = reason.indexOf('canary:opus');
    expect(policy).toBeGreaterThanOrEqual(0);
    expect(divergence).toBeGreaterThan(policy);
    expect(canaryAt).toBeGreaterThan(divergence);
  });
});
