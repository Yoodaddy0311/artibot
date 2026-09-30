/**
 * CA-02 — lib/core/model-canary.js, the reader of `routing.canary`.
 *
 * Pins: the canary vocabulary is a CLOSED allowlist (two classes, two tiers) and
 * anything outside it is ignored, never widened; a malformed carrier collapses to
 * "nothing armed" (fail-closed) exactly as the router's own normaliser does; the
 * two readers of the ONE key `routing.canary.actionClasses` cannot drift apart;
 * the JSON schema enums equal the code constants; and the REVIEW GUARD
 * ({@link canaryMayLower}) — the canary may lower a spawn only when its role is
 * absent or a build role, its agent's own default task is not review/architecture,
 * and the agent is off the canary's OWN protected list (independent of
 * FABLE_DENYLIST).
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
 *   4. Whether a caller passes the agent's default task. `canaryMayLower` can only
 *      judge what it is handed; the CLI hands it `agentTask` (pinned in
 *      `tests/scripts/model-routing-canary.test.js`), and a caller that hands none
 *      gets the role guard and the protected-agent floor, not the class guard.
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
  CANARY_LOWERABLE_AGENT_CLASSES,
  CANARY_PROTECTED_AGENTS,
  CANARY_SOURCE,
  CANARY_TIERS,
  canaryMayLower,
  canaryTierFor,
  outranksTier,
  readCanaryPlan,
} from '../../lib/core/model-canary.js';
import { OVERRIDE_TIERS } from '../../lib/core/model-overrides.js';
import { BUILD_ROLES, FABLE_DENYLIST, REVIEW_ROLES } from '../../lib/core/model-policy.js';
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

describe('the protected lists — design and review stay off the canary (SHOULD-1)', () => {
  it('CANARY_LOWERABLE_AGENT_CLASSES is the six default tasks the canary may lower for, frozen', () => {
    expect(CANARY_LOWERABLE_AGENT_CLASSES).toEqual(['classify', 'status', 'explore', 'edit-routine', 'implement', 'complex-debug']);
    expect(Object.isFrozen(CANARY_LOWERABLE_AGENT_CLASSES)).toBe(true);
  });

  it('is an allowlist: everything it leaves out of the eight action classes is exactly review and architecture', () => {
    // The owner's rule (2026-09-29): design and review = opus. The guard lists what MAY be lowered, so a ninth
    // action class is protected by default, and this is the gate that makes adding one a decision: the two
    // sides below must partition ACTION_CLASSES, with the protected side written out.
    for (const name of CANARY_LOWERABLE_AGENT_CLASSES) expect(ACTION_CLASSES).toContain(name);
    expect(ACTION_CLASSES.filter((name) => !CANARY_LOWERABLE_AGENT_CLASSES.includes(name)).sort()).toEqual(['architecture', 'review']);
    expect(new Set(CANARY_LOWERABLE_AGENT_CLASSES).size).toBe(CANARY_LOWERABLE_AGENT_CLASSES.length);
    expect(CANARY_LOWERABLE_AGENT_CLASSES.length + 2).toBe(ACTION_CLASSES.length);
  });

  it('every class the canary is armed FOR is one its own agents may be lowered for (no agent defaults to them, but the lists must not contradict)', () => {
    for (const name of CANARY_ACTION_CLASSES) expect(CANARY_LOWERABLE_AGENT_CLASSES).toContain(name);
  });

  it('CANARY_PROTECTED_AGENTS is security-reviewer today: bare lower-case names, frozen', () => {
    expect(CANARY_PROTECTED_AGENTS).toEqual(['security-reviewer']);
    expect(Object.isFrozen(CANARY_PROTECTED_AGENTS)).toBe(true);
    for (const name of CANARY_PROTECTED_AGENTS) {
      expect(name).toBe(name.trim().toLowerCase());
      expect(name).not.toContain(':');
    }
  });

  it('is its OWN list, not FABLE_DENYLIST: a different object, so widening one does not widen the other', () => {
    expect(CANARY_PROTECTED_AGENTS).not.toBe(FABLE_DENYLIST);
    // The behavioural half — an emptied or widened FABLE_DENYLIST does not move the canary's answer —
    // needs the module graph mocked, so it lives in tests/core/model-overrides-canary.test.js.
  });
});

describe('canaryMayLower — the guard is an allowlist of spawns', () => {
  const ok = Object.freeze({ agent: 'doc-updater' });
  const PROTECTED_CLASSES = Object.freeze(['review', 'architecture']);

  it('positive control: a plain agent with no role and no default task may be lowered', () => {
    expect(canaryMayLower(ok)).toBe(true);
    expect(canaryMayLower({ agent: 'artibot:doc-updater' })).toBe(true);
    expect(canaryMayLower({ agent: 'artibot-cowork:content-marketer' })).toBe(true);
  });

  it('a build-side role may be lowered — every word core reads as build — and so may "no role"', () => {
    for (const role of BUILD_ROLES) expect(canaryMayLower({ ...ok, role }), role).toBe(true);
    for (const role of [undefined, null]) expect(canaryMayLower({ ...ok, role }), String(role)).toBe(true);
  });

  it('a review-side role never is — every word core reads as review', () => {
    for (const role of REVIEW_ROLES) expect(canaryMayLower({ ...ok, role }), role).toBe(false);
  });

  it('a role that is neither absent nor a build word fails closed: an unknown word is not "build"', () => {
    // `planning` and `design` are exactly the roles the owner keeps on opus; core does not know them,
    // so the guard cannot read them as review and must not read them as build either.
    for (const role of ['planning', 'design', 'Build', ' build', 'BUILD', 'review ', '', 42, true, {}, ['build']]) {
      expect(canaryMayLower({ ...ok, role }), JSON.stringify(role)).toBe(false);
    }
  });

  it('an agent whose default task is one of the six may be lowered; none / undefined means "no default task"', () => {
    for (const agentTask of CANARY_LOWERABLE_AGENT_CLASSES) expect(canaryMayLower({ ...ok, agentTask }), agentTask).toBe(true);
    for (const agentTask of [undefined, null]) expect(canaryMayLower({ ...ok, agentTask }), String(agentTask)).toBe(true);
  });

  it('an agent whose default task is review or architecture never is', () => {
    for (const agentTask of PROTECTED_CLASSES) expect(canaryMayLower({ ...ok, agentTask }), agentTask).toBe(false);
  });

  it('a default task that is not EXACTLY one of the six fails closed — a near miss is not a class, so it is not lowered', () => {
    // The same doctrine as `canaryTierFor` (no trimming, no case folding), pointed the safe way round:
    // there a near miss arms nothing, here it protects.
    for (const agentTask of ['Review', ' architecture ', 'ARCHITECTURE', 'Implement', 'implement ', ' status', 'no-such-class', 'complex-debugging', '']) {
      expect(canaryMayLower({ ...ok, agentTask }), JSON.stringify(agentTask)).toBe(false);
    }
    for (const agentTask of [42, true, {}, ['review'], ['implement']]) {
      expect(canaryMayLower({ ...ok, agentTask }), JSON.stringify(agentTask)).toBe(false);
    }
  });

  it('a protected agent never is, bare, prefixed or upper-case, even with no role and no default task', () => {
    for (const agent of [...CANARY_PROTECTED_AGENTS, ...CANARY_PROTECTED_AGENTS.map((n) => `artibot:${n}`), 'artibot-cowork:Security-Reviewer', ' security-reviewer ']) {
      expect(canaryMayLower({ agent }), agent).toBe(false);
      expect(canaryMayLower({ agent, role: 'build', agentTask: 'implement' }), agent).toBe(false);
    }
  });

  it('a non-string or blank agent fails closed', () => {
    for (const agent of [undefined, null, 42, {}, '', '   ', ':', 'artibot:', ['doc-updater']]) {
      expect(canaryMayLower({ agent }), JSON.stringify(agent) ?? String(agent)).toBe(false);
    }
  });

  it('the conditions are ANDed: any one failing is enough, and the rest cannot outvote it', () => {
    expect(canaryMayLower({ agent: 'doc-updater', role: 'build', agentTask: 'implement' })).toBe(true);
    expect(canaryMayLower({ agent: 'doc-updater', role: 'review', agentTask: 'implement' })).toBe(false);
    expect(canaryMayLower({ agent: 'doc-updater', role: 'build', agentTask: 'review' })).toBe(false);
    expect(canaryMayLower({ agent: 'security-reviewer', role: 'build', agentTask: 'implement' })).toBe(false);
  });

  it('a spawn that is not a plain object fails closed and never throws', () => {
    for (const spawn of [undefined, null, 0, 'doc-updater', [], () => ok]) {
      expect(() => canaryMayLower(spawn), String(spawn)).not.toThrow();
      expect(canaryMayLower(spawn), String(spawn)).toBe(false);
    }
    expect(canaryMayLower()).toBe(false);
  });

  it('a throwing getter on the spawn is swallowed', () => {
    const spawn = { agent: 'doc-updater' };
    Object.defineProperty(spawn, 'role', { get: () => { throw new Error('hostile getter'); }, enumerable: true });
    expect(canaryMayLower(spawn)).toBe(false);
  });

  it('never mutates its input', () => {
    const spawn = Object.freeze({ agent: 'artibot:doc-updater', role: 'build', agentTask: 'implement' });
    expect(canaryMayLower(spawn)).toBe(true);
    expect(spawn).toEqual({ agent: 'artibot:doc-updater', role: 'build', agentTask: 'implement' });
  });
});
