/**
 * CA-02 — lib/core/model-canary.js, the reader of `routing.canary`.
 *
 * Pins: the canary vocabulary is a CLOSED allowlist (two classes, two tiers) and
 * anything outside it is ignored, never widened; a malformed carrier collapses to
 * "nothing armed" (fail-closed) exactly as the router's own normaliser does; the
 * two readers of the ONE key `routing.canary.actionClasses` cannot drift apart;
 * and the JSON schema enums equal the code constants.
 *
 * WHAT THIS GATE CANNOT SEE:
 *   1. Whether a spawn is ever resolved with `--task classify|status` — no agent
 *      DEFAULTS to those two classes (`AGENT_ACTION_CLASS`), so only a leader that
 *      names the task reaches this reader at all.
 *   2. Whether the host serves what `resolve` printed. Only a live served-model
 *      check (`usage.receipt`) shows that.
 *   3. `lib/core/model-overrides.js#resolveEffectiveModel` — how the answer is
 *      layered under the user's settings is pinned in
 *      `tests/core/model-overrides.test.js` and, through the CLI, in
 *      `tests/scripts/model-routing-canary.test.js`.
 *
 * @module tests/core/model-canary
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { configSchema, validateConfig } from '../../lib/core/config-schema.js';
import { listTiers } from '../../lib/core/model-catalog.js';
import {
  CANARY_ACTION_CLASSES,
  CANARY_SOURCE,
  CANARY_TIERS,
  canaryTierFor,
  outranksTier,
  readCanaryPlan,
} from '../../lib/core/model-canary.js';
import { OVERRIDE_TIERS } from '../../lib/core/model-overrides.js';
import { ACTION_CLASSES } from '../../lib/routing/action-classifier.js';
import { resolveCanaryClasses } from '../../lib/routing/adaptive-model-router.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shipped = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf8'));

/** A config carrying exactly this `routing.canary` value. */
const cfg = (canary) => ({ routing: { canary } });

/** Carriers no reader may act on. Mirrors `canary-actionclass-gate.test.js#UNUSABLE`, plus `tier` shapes. */
const UNUSABLE_LISTS = Object.freeze([
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
  { actionClasses: ['classify', '   '] },
  { actionClasses: ['classify', null] },
  { actionClasses: ['classify', undefined] },
  { actionClasses: [{}] },
  { actionClasses: [['classify']] },
]);

describe('the closed vocabulary', () => {
  it('names exactly the two classes CA-02 names, frozen', () => {
    expect(CANARY_ACTION_CLASSES).toEqual(['classify', 'status']);
    expect(Object.isFrozen(CANARY_ACTION_CLASSES)).toBe(true);
  });

  it('is a subset of the eight action classes (drift gate against lib/routing)', () => {
    for (const name of CANARY_ACTION_CLASSES) expect(ACTION_CLASSES).toContain(name);
  });

  it('offers the two cheap tiers the design names ("haiku/sonnet"), never opus or fable', () => {
    expect(CANARY_TIERS).toEqual(['haiku', 'sonnet']);
    expect(Object.isFrozen(CANARY_TIERS)).toBe(true);
    for (const tier of CANARY_TIERS) expect(OVERRIDE_TIERS).toContain(tier);
    expect(CANARY_TIERS).not.toContain('opus');
    expect(CANARY_TIERS).not.toContain('fable');
  });

  it('labels its answers with a source no user layer uses', () => {
    expect(CANARY_SOURCE).toBe('canary-task');
    expect(CANARY_SOURCE.startsWith('override-')).toBe(false);
  });

  it('the JSON schema enums ARE these constants (one vocabulary, two files)', () => {
    const canary = configSchema.properties.routing.properties.canary.properties;
    expect(canary.actionClasses.items.enum).toEqual([...CANARY_ACTION_CLASSES]);
    expect(canary.tier.enum).toEqual([...CANARY_TIERS]);
  });
});

describe('readCanaryPlan — the shipped file', () => {
  it('arms classify and status onto the low tier, and ignores nothing', () => {
    expect(readCanaryPlan(shipped)).toEqual({ classes: ['classify', 'status'], tier: 'sonnet', ignored: [] });
  });

  it('the shipped list survives the schema validator (a member outside the enum would warn at every config load)', () => {
    expect(validateConfig(shipped)).toEqual({ valid: true, errors: [] });
  });

  it('negative control: the same validator flags a class or a tier outside the vocabulary', () => {
    // `loadConfig()` prints each error as `[artibot] config warning: …`, so this is the loud half of
    // "ignored": the reader drops the name silently, the schema says so at load time.
    const badClass = structuredClone(shipped);
    badClass.routing.canary.actionClasses = ['classify', 'explore'];
    const a = validateConfig(badClass);
    expect(a.valid).toBe(false);
    expect(a.errors.join('\n')).toMatch(/routing\.canary\.actionClasses\[1\].*explore/);

    const badTier = structuredClone(shipped);
    badTier.routing.canary.tier = 'opus';
    const b = validateConfig(badTier);
    expect(b.valid).toBe(false);
    expect(b.errors.join('\n')).toMatch(/routing\.canary\.tier.*opus/);
  });
});

describe('readCanaryPlan — classes are an allowlist', () => {
  it('keeps only classify and status; every other string is IGNORED, not applied', () => {
    const plan = readCanaryPlan(cfg({
      actionClasses: ['classify', 'explore', 'status', 'architecture', 'Classify', ' status ', 'implement', '__x__'],
      tier: 'sonnet',
    }));
    // ' status ' is trimmed (the router trims too); 'Classify' is a different word.
    expect(plan.classes).toEqual(['classify', 'status']);
    expect(plan.ignored).toEqual(['explore', 'architecture', 'Classify', 'implement', '__x__']);
  });

  it('de-duplicates on both sides', () => {
    const plan = readCanaryPlan(cfg({ actionClasses: ['status', 'status', 'x', 'x'], tier: 'haiku' }));
    expect(plan).toEqual({ classes: ['status'], tier: 'haiku', ignored: ['x'] });
  });

  it('does not treat a NEW action class as armed (allowlist, not denylist)', () => {
    // Everything of the eight that is not in the two-name vocabulary stays off,
    // whatever the list says — the direction that stays safe as classes are added.
    for (const name of ACTION_CLASSES.filter((c) => !CANARY_ACTION_CLASSES.includes(c))) {
      expect(readCanaryPlan(cfg({ actionClasses: [name], tier: 'sonnet' })).classes, name).toEqual([]);
      expect(canaryTierFor(cfg({ actionClasses: [name], tier: 'sonnet' }), name), name).toBeNull();
    }
  });

  it.each(UNUSABLE_LISTS.map((carrier, i) => [i, carrier]))('an unusable carrier #%i collapses to nothing armed', (_i, carrier) => {
    const plan = readCanaryPlan(cfg(carrier));
    expect(plan.classes).toEqual([]);
    expect(plan.ignored).toEqual([]);
    expect(canaryTierFor(cfg(carrier), 'classify')).toBeNull();
  });

  it('ONE unusable member discards the WHOLE list, never the readable half', () => {
    const half = readCanaryPlan(cfg({ actionClasses: ['classify', 42, 'status'], tier: 'sonnet' }));
    expect(half.classes).toEqual([]);
    expect(canaryTierFor(cfg({ actionClasses: ['classify', 42, 'status'], tier: 'sonnet' }), 'classify')).toBeNull();
  });

  it('a config that cannot carry a canary at all is inert and never throws', () => {
    for (const config of [undefined, null, 0, 'x', [], {}, { routing: null }, { routing: [] }, { routing: {} }, { routing: { canary: null } }]) {
      expect(readCanaryPlan(config), String(config)).toEqual({ classes: [], tier: null, ignored: [] });
      expect(canaryTierFor(config, 'classify'), String(config)).toBeNull();
    }
  });

  it('a throwing getter anywhere on the path is swallowed', () => {
    const boom = () => { throw new Error('hostile getter'); };
    const routing = {};
    Object.defineProperty(routing, 'canary', { get: boom, enumerable: true });
    const onRouting = {};
    Object.defineProperty(onRouting, 'routing', { get: boom, enumerable: true });
    const list = { tier: 'sonnet' };
    Object.defineProperty(list, 'actionClasses', { get: boom, enumerable: true });
    for (const config of [{ routing }, onRouting, cfg(list)]) {
      expect(canaryTierFor(config, 'classify')).toBeNull();
    }
  });

  it('never mutates its input', () => {
    const config = Object.freeze({
      routing: Object.freeze({ canary: Object.freeze({ actionClasses: Object.freeze(['classify', 'x']), tier: 'sonnet' }) }),
    });
    expect(() => readCanaryPlan(config)).not.toThrow();
    expect(config.routing.canary.actionClasses).toEqual(['classify', 'x']);
  });
});

describe('readCanaryPlan — one vocabulary for the ONE key', () => {
  // `adaptive-model-router.js#resolveCanaryClasses` reads the same key for the
  // receipt path. The two must agree on every carrier: the actuator's classes are
  // the router's classes narrowed to the closed vocabulary — never a different list.
  const CARRIERS = Object.freeze([
    ...UNUSABLE_LISTS.map((c) => c),
    { actionClasses: ['classify'] },
    { actionClasses: ['status', 'classify'] },
    { actionClasses: ['classify', 'explore'] },
    { actionClasses: ['explore', 'review', 'architecture'] },
    { actionClasses: [' classify ', 'status'] },
    { actionClasses: ['Classify', 'STATUS'] },
    { actionClasses: ['classify', 'classify'] },
    { actionClasses: ['__no_such_class__'] },
  ]);

  it.each(CARRIERS.map((carrier, i) => [i, carrier]))('carrier #%i: actuator === router ∩ vocabulary', (_i, carrier) => {
    const viaRouter = resolveCanaryClasses(carrier).filter((name) => CANARY_ACTION_CLASSES.includes(name));
    const viaCore = readCanaryPlan(cfg(carrier)).classes;
    expect([...new Set(viaRouter)].sort()).toEqual([...viaCore].sort());
  });
});

describe('readCanaryPlan — tier is a closed allowlist, and absent means OFF', () => {
  it.each(CANARY_TIERS)('accepts %s', (tier) => {
    expect(readCanaryPlan(cfg({ actionClasses: ['classify'], tier })).tier).toBe(tier);
    expect(canaryTierFor(cfg({ actionClasses: ['classify'], tier }), 'classify')).toBe(tier);
  });

  it.each([
    ['opus', 'opus'], ['fable', 'fable'], ['Sonnet', 'Sonnet'], [' sonnet', ' sonnet'], ['', ''], ['sonnet ', 'sonnet '],
    ['a number', 42], ['null', null], ['undefined', undefined], ['an array', ['sonnet']], ['an object', { tier: 'sonnet' }], ['an alias', 'deep-async'],
  ])('rejects %s: the canary applies to nothing rather than to a tier its author did not name', (_label, tier) => {
    const config = cfg({ actionClasses: ['classify', 'status'], tier });
    expect(readCanaryPlan(config).tier).toBeNull();
    expect(canaryTierFor(config, 'classify')).toBeNull();
    expect(canaryTierFor(config, 'status')).toBeNull();
  });

  it('a list with no tier key is OFF — there is no hidden default tier', () => {
    expect(canaryTierFor(cfg({ actionClasses: ['classify', 'status'] }), 'classify')).toBeNull();
  });
});

describe('canaryTierFor — per-task lookup', () => {
  const armed = cfg({ actionClasses: ['classify', 'status'], tier: 'sonnet' });

  it('positive control: classify and status answer the tier', () => {
    expect(canaryTierFor(armed, 'classify')).toBe('sonnet');
    expect(canaryTierFor(armed, 'status')).toBe('sonnet');
  });

  it('negative control: every other class answers nothing', () => {
    for (const name of ACTION_CLASSES.filter((c) => !CANARY_ACTION_CLASSES.includes(c))) {
      expect(canaryTierFor(armed, name), name).toBeNull();
    }
  });

  it('each class is armed on its own — naming one does not arm the other', () => {
    expect(canaryTierFor(cfg({ actionClasses: ['classify'], tier: 'haiku' }), 'status')).toBeNull();
    expect(canaryTierFor(cfg({ actionClasses: ['status'], tier: 'haiku' }), 'classify')).toBeNull();
    expect(canaryTierFor(cfg({ actionClasses: ['status'], tier: 'haiku' }), 'status')).toBe('haiku');
  });

  it('an empty list (the pre-CA-02 shipped value) arms nothing', () => {
    expect(canaryTierFor(cfg({ actionClasses: [], tier: 'sonnet' }), 'classify')).toBeNull();
  });

  it('a task that is not exactly a class word is nothing', () => {
    for (const task of [undefined, null, 42, '', ' classify', 'Classify', 'CLASSIFY', 'classify ', ['classify'], { task: 'classify' }, 'complex-debugging']) {
      expect(canaryTierFor(armed, task), JSON.stringify(task) ?? String(task)).toBeNull();
    }
  });
});

describe('outranksTier — the never-raise comparator', () => {
  it('orders the catalog cheapest → most capable, strictly', () => {
    expect(listTiers()).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(outranksTier('sonnet', 'haiku')).toBe(true);
    expect(outranksTier('opus', 'sonnet')).toBe(true);
    expect(outranksTier('fable', 'opus')).toBe(true);
    expect(outranksTier('fable', 'haiku')).toBe(true);
  });

  it('equal or lower is false (a canary never raises a seat)', () => {
    for (const tier of listTiers()) expect(outranksTier(tier, tier), tier).toBe(false);
    expect(outranksTier('haiku', 'sonnet')).toBe(false);
    expect(outranksTier('sonnet', 'opus')).toBe(false);
  });

  it('an unknown or non-string tier never outranks and is never outranked', () => {
    for (const bad of ['', 'gpt', 'Opus', 42, null, undefined, {}, ['opus']]) {
      expect(outranksTier(bad, 'sonnet'), String(bad)).toBe(false);
      expect(outranksTier('opus', bad), String(bad)).toBe(false);
    }
  });
});
