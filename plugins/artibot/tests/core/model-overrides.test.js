/**
 * Gate N1 — lib/core/model-overrides.js.
 *
 * Pins: with no override in play, resolveEffectiveModel is byte-identical to
 * resolveModel for every shipped agent × role; the fable gate and
 * FABLE_DENYLIST run after any user pick; artibot and artibot-cowork never
 * share a key; the file schema is an allowlist; loadOverrides never throws.
 *
 * WHAT THIS GATE CANNOT SEE:
 *   1. Whether the host honors the effective value — frontmatter `model:` is
 *      what a spawn uses unless the leader passes Agent(model=...). Only a live
 *      served-model check can show that.
 *   2. Whether the leader actually passes the resolved value to the spawn.
 *   3. Whether installed copies (plugin cache, global ~/.claude/artibot copy)
 *      match this repo.
 *   4. The served model id → tier mapping — that holds only for ids the
 *      catalog knows.
 *   5. Observe metrics mixing: while an override is on, user-chosen spawns land
 *      unlabeled in the same match-rate rows as policy-chosen ones.
 *   6. Callers that omit opts.task get no task layer (fail-safe). The model-routing
 *      CLI and split-brief (the agent's default task) pass it; any other caller must.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveArtibotDir } from '../../lib/core/config.js';
import {
  allowedTiersFor,
  clearAll,
  clearOverride,
  emptyOverrides,
  loadOverrides,
  OVERRIDE_TIERS,
  OVERRIDES_FILENAME,
  overridesPath,
  PLUGIN_NAMES,
  qualifyAgent,
  resolveEffectiveModel,
  SCHEMA_VERSION,
  setOverride,
  validateOverrides,
} from '../../lib/core/model-overrides.js';
import { resolveModel } from '../../lib/core/model-policy.js';
import { ACTION_CLASSES } from '../../lib/routing/action-classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(__dirname, '..', '..');

// Shipped config read from disk and passed explicitly — never the module cache.
const shippedConfig = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf8'));
// Same file with the kill-switch on, so fable assertions exercise an OPEN gate.
const gateOnConfig = structuredClone(shippedConfig);
gateOnConfig.agents.modelPolicy.fable.enabled = true;
gateOnConfig.agents.modelPolicy.phaseRoles.review = 'fable';

const AGENTS = readdirSync(path.join(PLUGIN_ROOT, 'agents'))
  .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
  .map((f) => f.slice(0, -'.md'.length))
  .sort();
const ROLE_OPTS = [{}, { role: 'build' }, { role: 'review' }];

// Injected cowork frontmatter. planner = sonnet on purpose: the core planner
// resolves to opus, so a leak through the core policy would show.
const COWORK_FM = Object.freeze({ planner: 'sonnet', 'case-study-writer': 'sonnet', orchestrator: 'opus' });

/** Full resolveEffectiveModel result shape. */
const R = (model, source, { reason = null, requested = null, scope = null } = {}) => ({ model, source, reason, requested, scope });
const SHIPPED = (model) => R(model, 'shipped');
const UNKNOWN = R(null, 'cowork-frontmatter-unknown');

/** Recursively freeze so any mutation of an input throws in strict mode. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const tmpDirs = [];
function tmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-model-overrides-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe('model-overrides — constants', () => {
  it('exposes the allowlists and file name', () => {
    expect(OVERRIDE_TIERS).toEqual(['haiku', 'sonnet', 'opus']);
    expect(Object.isFrozen(OVERRIDE_TIERS)).toBe(true);
    expect(PLUGIN_NAMES).toEqual(['artibot', 'artibot-cowork']);
    expect(Object.isFrozen(PLUGIN_NAMES)).toBe(true);
    expect(SCHEMA_VERSION).toBe(1);
    expect(OVERRIDES_FILENAME).toBe('model-routing.json');
  });

  it('overridesPath resolves inside the given dir, and defaults to resolveArtibotDir()', () => {
    const dir = tmpDir();
    expect(overridesPath(dir)).toBe(path.resolve(dir, 'model-routing.json'));
    expect(overridesPath()).toBe(path.resolve(resolveArtibotDir(), 'model-routing.json'));
  });

  it('emptyOverrides has no phaseRoles for cowork and returns a fresh object', () => {
    const a = emptyOverrides();
    expect(a).toEqual({
      schemaVersion: 1,
      plugins: {
        artibot: { default: null, agents: {}, phaseRoles: {} },
        'artibot-cowork': { default: null, agents: {} },
      },
    });
    expect(emptyOverrides()).not.toBe(a);
    expect(clearAll()).toEqual(a);
  });
});

describe('qualifyAgent', () => {
  it('splits qualified and bare names', () => {
    expect(qualifyAgent('artibot:planner')).toEqual({ plugin: 'artibot', agent: 'planner', qualified: true });
    expect(qualifyAgent('artibot-cowork:planner')).toEqual({ plugin: 'artibot-cowork', agent: 'planner', qualified: true });
    expect(qualifyAgent('  Planner ')).toEqual({ plugin: null, agent: 'planner', qualified: false });
  });

  it('rejects other prefixes, empty names and non-strings', () => {
    for (const bad of ['other:planner', '', '   ', 'artibot:', 'artibot-cowork:  ', 'artibot:a:b', 42, null]) {
      expect(qualifyAgent(bad)).toBeNull();
    }
  });
});

describe('N1 — byte-identical wrapper with no override in play', () => {
  it(`covers every shipped agent (${AGENTS.length})`, () => {
    expect(AGENTS).toHaveLength(30);
  });

  for (const [label, overrides] of [['null', null], ['emptyOverrides()', emptyOverrides()]]) {
    for (const [cfgLabel, config] of [['shipped', shippedConfig], ['gate-on', gateOnConfig]]) {
      it(`overrides=${label}, config=${cfgLabel}: 30 agents × 3 roles equal resolveModel`, () => {
        let checked = 0;
        for (const agent of AGENTS) {
          for (const opts of ROLE_OPTS) {
            for (const name of [agent, `artibot:${agent}`]) {
              const got = resolveEffectiveModel(name, opts, { config, overrides });
              expect(got.model, `${name} ${JSON.stringify(opts)}`).toBe(resolveModel(name, opts, config));
              expect(got).toEqual(SHIPPED(got.model));
              checked += 1;
            }
          }
        }
        expect(checked).toBe(30 * 3 * 2);
      });
    }
  }

  it('role aliases bypass overrides and match resolveModel', () => {
    const ov = setOverride(null, { scope: 'plugin', plugin: 'artibot', tier: 'haiku' });
    for (const alias of ['deep-async', 'frontier', 'opus']) {
      const got = resolveEffectiveModel(alias, {}, { config: shippedConfig, overrides: ov });
      expect(got).toEqual(SHIPPED(resolveModel(alias, {}, shippedConfig)));
    }
  });
});

describe('F2 — injected override values outside the tier vocabulary are ignored', () => {
  const inject = (block) => ({ schemaVersion: 1, plugins: { artibot: block } });

  it('agent value "FABLE" on security-reviewer falls through to shipped', () => {
    const ov = inject({ agents: { 'security-reviewer': 'FABLE' } });
    for (const config of [shippedConfig, gateOnConfig]) {
      expect(resolveEffectiveModel('security-reviewer', {}, { config, overrides: ov }))
        .toEqual(SHIPPED(resolveModel('security-reviewer', {}, config)));
    }
  });

  it('miscased, alias and non-string values skip to the next layer', () => {
    for (const bad of ['Opus', 'FABLE', 'deep-async', 'frontier', ' opus', '', 42, null, true, ['opus'], { tier: 'opus' }]) {
      const ov = inject({ default: 'sonnet', agents: { planner: bad }, phaseRoles: { review: bad } });
      const label = JSON.stringify(bad);
      expect(resolveEffectiveModel('planner', {}, { config: shippedConfig, overrides: ov }), label)
        .toEqual(R('sonnet', 'override-plugin', { requested: 'sonnet', scope: 'plugin' }));
      expect(resolveEffectiveModel('planner', { role: 'review' }, { config: shippedConfig, overrides: ov }), label)
        .toEqual(R('sonnet', 'override-plugin', { requested: 'sonnet', scope: 'plugin' }));
      const noDefault = inject({ default: bad, agents: { planner: bad } });
      expect(resolveEffectiveModel('planner', {}, { config: shippedConfig, overrides: noDefault }), label)
        .toEqual(SHIPPED(resolveModel('planner', {}, shippedConfig)));
    }
  });

  it('miscased cowork frontmatter reads as unknown', () => {
    expect(resolveEffectiveModel('artibot-cowork:planner', {}, { config: shippedConfig, coworkFrontmatter: { planner: 'Sonnet' } }))
      .toEqual(UNKNOWN);
  });
});

describe('F3 — alias-shaped cowork names never reach the core policy', () => {
  const fm = { 'deep-async': 'sonnet', haiku: 'sonnet' };

  it('artibot-cowork:<alias|tier> answers from the cowork layers only', () => {
    for (const name of ['artibot-cowork:deep-async', 'artibot-cowork:haiku', 'artibot-cowork:opus']) {
      expect(resolveEffectiveModel(name, {}, { config: shippedConfig }), name).toEqual(UNKNOWN);
    }
    expect(resolveEffectiveModel('artibot-cowork:deep-async', {}, { config: shippedConfig, coworkFrontmatter: fm }))
      .toEqual(R('sonnet', 'cowork-frontmatter', { requested: 'sonnet' }));
    const ov = setOverride(null, { scope: 'plugin', plugin: 'artibot-cowork', tier: 'haiku' });
    expect(resolveEffectiveModel('artibot-cowork:haiku', {}, { config: shippedConfig, overrides: ov }))
      .toEqual(R('haiku', 'override-plugin', { requested: 'haiku', scope: 'plugin' }));
  });

  it('unparseable artibot-cowork names are unknown, not core shipped', () => {
    for (const name of ['artibot-cowork:', 'artibot-cowork:  ', 'artibot-cowork:a:b']) {
      expect(resolveEffectiveModel(name, {}, { config: shippedConfig, coworkFrontmatter: COWORK_FM }), name).toEqual(UNKNOWN);
    }
  });

  it('the core side keeps its alias fast path, untouched by cowork overrides', () => {
    const ov = setOverride(null, { scope: 'plugin', plugin: 'artibot-cowork', tier: 'haiku' });
    for (const name of ['deep-async', 'artibot:deep-async', 'artibot:haiku']) {
      expect(resolveEffectiveModel(name, {}, { config: shippedConfig, overrides: ov, coworkFrontmatter: fm }), name)
        .toEqual(SHIPPED(resolveModel(name, {}, shippedConfig)));
    }
  });
});

describe('precedence and positive control', () => {
  const base = deepFreeze(
    setOverride(
      setOverride(
        setOverride(null, { scope: 'agent', plugin: 'artibot', key: 'planner', tier: 'haiku' }),
        { scope: 'phase', plugin: 'artibot', key: 'review', tier: 'sonnet' },
      ),
      { scope: 'plugin', plugin: 'artibot', tier: 'haiku' },
    ),
  );
  const ctx = { config: shippedConfig, overrides: base };

  it('an agent override actually changes the result (shipped is opus)', () => {
    expect(resolveModel('planner', {}, shippedConfig)).toBe('opus');
    expect(resolveEffectiveModel('artibot:planner', {}, ctx))
      .toEqual(R('haiku', 'override-agent', { requested: 'haiku', scope: 'agent' }));
  });

  it('agent beats phase beats plugin default', () => {
    expect(resolveEffectiveModel('planner', { role: 'review' }, ctx).scope).toBe('agent');
    expect(resolveEffectiveModel('architect', { role: 'review' }, ctx))
      .toEqual(R('sonnet', 'override-phase', { requested: 'sonnet', scope: 'phase' }));
    expect(resolveEffectiveModel('architect', { role: 'inspect' }, ctx).source).toBe('override-phase');
    expect(resolveEffectiveModel('architect', { role: 'build' }, ctx))
      .toEqual(R('haiku', 'override-plugin', { requested: 'haiku', scope: 'plugin' }));
    expect(resolveEffectiveModel('architect', {}, ctx).source).toBe('override-plugin');
  });

  it('phase override applies to artibot only', () => {
    const ov = setOverride(null, { scope: 'phase', plugin: 'artibot', key: 'build', tier: 'sonnet' });
    expect(resolveEffectiveModel('artibot:planner', { role: 'build' }, { config: shippedConfig, overrides: ov }).model).toBe('sonnet');
    const cowork = resolveEffectiveModel('artibot-cowork:planner', { role: 'build' }, { config: shippedConfig, overrides: ov, coworkFrontmatter: COWORK_FM });
    expect(cowork).toEqual(R('sonnet', 'cowork-frontmatter', { requested: 'sonnet' }));
    const coworkOpus = resolveEffectiveModel('artibot-cowork:orchestrator', { role: 'build' }, { config: shippedConfig, overrides: ov, coworkFrontmatter: COWORK_FM });
    expect(coworkOpus.model).toBe('opus');
    expect(() => setOverride(null, { scope: 'phase', plugin: 'artibot-cowork', key: 'build', tier: 'sonnet' })).toThrow(TypeError);
  });

  it('plugin default applies when no agent override exists', () => {
    const ov = setOverride(null, { scope: 'plugin', plugin: 'artibot-cowork', tier: 'haiku' });
    expect(resolveEffectiveModel('artibot-cowork:orchestrator', {}, { config: shippedConfig, overrides: ov, coworkFrontmatter: COWORK_FM }))
      .toEqual(R('haiku', 'override-plugin', { requested: 'haiku', scope: 'plugin' }));
  });
});

describe('fable gate and denylist run last', () => {
  it('security-reviewer set to fable lands on opus with reason denylist, even with the gate on', () => {
    const ov = { schemaVersion: 1, plugins: { artibot: { default: null, agents: { 'security-reviewer': 'fable' }, phaseRoles: {} } } };
    expect(resolveEffectiveModel('artibot:security-reviewer', {}, { config: gateOnConfig, overrides: ov }))
      .toEqual(R('opus', 'override-agent', { reason: 'denylist', requested: 'fable', scope: 'agent' }));
    const byDefault = setOverride(null, { scope: 'plugin', plugin: 'artibot', tier: 'fable', config: gateOnConfig });
    expect(resolveEffectiveModel('security-reviewer', {}, { config: gateOnConfig, overrides: byDefault }))
      .toEqual(R('opus', 'override-plugin', { reason: 'denylist', requested: 'fable', scope: 'plugin' }));
    expect(() => setOverride(null, { scope: 'agent', plugin: 'artibot', key: 'security-reviewer', tier: 'fable', config: gateOnConfig }))
      .toThrow(/FABLE_DENYLIST/);
  });

  it('an allowlisted agent set to fable: gate on → fable, shipped gate off → opus + fable-gate', () => {
    const ov = setOverride(null, { scope: 'agent', plugin: 'artibot', key: 'architect', tier: 'fable', config: gateOnConfig });
    expect(resolveEffectiveModel('architect', {}, { config: gateOnConfig, overrides: ov }))
      .toEqual(R('fable', 'override-agent', { requested: 'fable', scope: 'agent' }));
    expect(resolveEffectiveModel('architect', {}, { config: shippedConfig, overrides: ov }))
      .toEqual(R('opus', 'override-agent', { reason: 'fable-gate', requested: 'fable', scope: 'agent' }));
  });

  it('a non-allowlisted agent set to fable is demoted even with the gate on', () => {
    const ov = setOverride(null, { scope: 'agent', plugin: 'artibot', key: 'backend-developer', tier: 'fable', config: gateOnConfig });
    expect(resolveEffectiveModel('backend-developer', {}, { config: gateOnConfig, overrides: ov }))
      .toEqual(R('opus', 'override-agent', { reason: 'fable-gate', requested: 'fable', scope: 'agent' }));
  });

  it('cowork is never fable, even for a name on the core allowlist', () => {
    const ov = setOverride(null, { scope: 'agent', plugin: 'artibot-cowork', key: 'planner', tier: 'fable', config: gateOnConfig });
    expect(resolveEffectiveModel('artibot-cowork:planner', {}, { config: gateOnConfig, overrides: ov, coworkFrontmatter: COWORK_FM }))
      .toEqual(R('opus', 'override-agent', { reason: 'fable-gate', requested: 'fable', scope: 'agent' }));
    expect(resolveEffectiveModel('artibot-cowork:planner', {}, { config: gateOnConfig, coworkFrontmatter: { planner: 'fable' } }))
      .toEqual(R('opus', 'cowork-frontmatter', { reason: 'fable-gate', requested: 'fable' }));
  });
});

describe('cowork isolation (design P2)', () => {
  const ctx = (overrides) => ({ config: shippedConfig, overrides, coworkFrontmatter: COWORK_FM });

  it('a cowork override does not reach the core agent', () => {
    const ov = setOverride(null, { scope: 'agent', plugin: 'artibot-cowork', key: 'planner', tier: 'haiku' });
    expect(resolveEffectiveModel('artibot-cowork:planner', {}, ctx(ov)).model).toBe('haiku');
    expect(resolveEffectiveModel('artibot:planner', {}, ctx(ov))).toEqual(SHIPPED(resolveModel('planner', {}, shippedConfig)));
    expect(resolveEffectiveModel('planner', {}, ctx(ov)).source).toBe('shipped');
  });

  it('a core override does not reach the cowork agent', () => {
    const ov = setOverride(null, { scope: 'agent', plugin: 'artibot', key: 'planner', tier: 'haiku' });
    expect(resolveEffectiveModel('artibot:planner', {}, ctx(ov)).model).toBe('haiku');
    expect(resolveEffectiveModel('artibot-cowork:planner', {}, ctx(ov))).toEqual(R('sonnet', 'cowork-frontmatter', { requested: 'sonnet' }));
  });

  it('no override → the injected cowork frontmatter, never the core policy', () => {
    expect(resolveModel('artibot-cowork:planner', {}, shippedConfig)).toBe('opus');
    for (const overrides of [null, emptyOverrides()]) {
      expect(resolveEffectiveModel('artibot-cowork:planner', {}, ctx(overrides))).toEqual(R('sonnet', 'cowork-frontmatter', { requested: 'sonnet' }));
    }
  });

  it('unknown cowork frontmatter → model null, never a core fallback', () => {
    expect(resolveEffectiveModel('artibot-cowork:planner', {}, { config: shippedConfig })).toEqual(UNKNOWN);
    expect(resolveEffectiveModel('artibot-cowork:long-form-writer', {}, ctx(null))).toEqual(UNKNOWN);
    expect(resolveEffectiveModel('artibot-cowork:constructor', {}, ctx(null))).toEqual(UNKNOWN);
  });
});

describe('validateOverrides — allowlist schema', () => {
  const withArtibot = (block) => ({ schemaVersion: 1, plugins: { artibot: block } });
  const reject = (doc, pattern, config = shippedConfig) => {
    const res = validateOverrides(doc, { config });
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toMatch(pattern);
  };

  it('accepts emptyOverrides() and a populated document', () => {
    expect(validateOverrides(emptyOverrides(), { config: shippedConfig })).toEqual({ ok: true, errors: [] });
    const doc = setOverride(setOverride(null, { scope: 'phase', plugin: 'artibot', key: 'review', tier: 'sonnet' }), { scope: 'agent', plugin: 'artibot-cowork', key: 'planner', tier: 'haiku' });
    expect(validateOverrides({ ...doc, updatedAt: '2026-09-23T00:00:00Z' }, { config: shippedConfig }).ok).toBe(true);
  });

  it('rejects an unknown tier', () => reject(withArtibot({ agents: { planner: 'gpt-5' } }), /tier "gpt-5"/));
  it('rejects a role alias as a tier', () => reject(withArtibot({ default: 'deep-async' }), /tier "deep-async"/));
  it('rejects an unknown top-level key', () => reject({ ...emptyOverrides(), extra: 1 }, /unknown key "extra"/));
  it('rejects an unknown plugin', () => reject({ schemaVersion: 1, plugins: { 'other-plugin': {} } }, /unknown plugin "other-plugin"/));
  it('rejects an unknown per-plugin key', () => reject(withArtibot({ model: 'opus' }), /unknown key "model"/));
  it('rejects phaseRoles on cowork', () => reject({ schemaVersion: 1, plugins: { 'artibot-cowork': { phaseRoles: {} } } }, /unknown key "phaseRoles"/));
  it('rejects a phase outside build/review', () => reject(withArtibot({ phaseRoles: { deploy: 'opus' } }), /unknown phase "deploy"/));
  it('rejects schemaVersion 2', () => reject({ ...emptyOverrides(), schemaVersion: 2 }, /schemaVersion/));
  it('rejects fable while the gate is off', () => reject(withArtibot({ agents: { architect: 'fable' } }), /tier "fable"/));
  it('rejects fable when no config is given', () => reject(withArtibot({ default: 'fable' }), /tier "fable"/, undefined));
  it('rejects security-reviewer on fable even with the gate on', () => reject(withArtibot({ agents: { 'security-reviewer': 'fable' } }), /FABLE_DENYLIST/, gateOnConfig));
  it('rejects qualified, uppercase and prototype agent keys', () => {
    reject(withArtibot({ agents: { 'artibot:planner': 'opus' } }), /bare lowercase/);
    reject(withArtibot({ agents: { Planner: 'opus' } }), /bare lowercase/);
    reject(JSON.parse('{"schemaVersion":1,"plugins":{"artibot":{"agents":{"__proto__":"opus"}}}}'), /bare lowercase/);
  });
  it('rejects non-objects', () => {
    for (const bad of [null, [], 'x', 1]) expect(validateOverrides(bad).ok).toBe(false);
    reject({ schemaVersion: 1, plugins: [] }, /plugins: must be an object/);
  });
  it('accepts fable with the gate on for an allowlisted agent', () => {
    expect(validateOverrides(withArtibot({ agents: { architect: 'fable' } }), { config: gateOnConfig }).ok).toBe(true);
  });

  it('write is the default mode (explicit write behaves the same)', () => {
    const doc = withArtibot({ agents: { architect: 'fable' } });
    expect(validateOverrides(doc, { config: shippedConfig, mode: 'write' })).toEqual(validateOverrides(doc, { config: shippedConfig }));
    expect(validateOverrides(doc, { config: shippedConfig, mode: 'write' }).ok).toBe(false);
  });

  it('load mode checks vocabulary only: fable and denylist+fable pass, whatever the gate', () => {
    const doc = withArtibot({ default: 'fable', agents: { architect: 'fable', 'security-reviewer': 'fable' }, phaseRoles: { review: 'fable' } });
    for (const config of [undefined, shippedConfig, gateOnConfig]) {
      expect(validateOverrides(doc, { config, mode: 'load' })).toEqual({ ok: true, errors: [] });
    }
  });

  it('load mode still rejects non-vocabulary tiers and unknown structure', () => {
    for (const bad of ['FABLE', 'Opus', 'deep-async', 42]) {
      expect(validateOverrides(withArtibot({ agents: { planner: bad } }), { mode: 'load' }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateOverrides({ ...emptyOverrides(), extra: 1 }, { mode: 'load' }).ok).toBe(false);
  });

  it('an unknown mode fails closed', () => {
    const res = validateOverrides(emptyOverrides(), { mode: 'lenient' });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/mode/);
  });

  it('allowedTiersFor is exported and gate-aware, returning a fresh array', () => {
    expect(allowedTiersFor(shippedConfig)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(allowedTiersFor(undefined)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(allowedTiersFor(gateOnConfig)).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(allowedTiersFor(shippedConfig)).not.toBe(allowedTiersFor(shippedConfig));
  });
});

describe('pure setters never mutate their input', () => {
  const frozen = deepFreeze(setOverride(null, { scope: 'agent', plugin: 'artibot', key: 'planner', tier: 'haiku' }));

  it('setOverride / clearOverride return new objects', () => {
    const snapshot = JSON.stringify(frozen);
    const set = setOverride(frozen, { scope: 'agent', plugin: 'artibot', key: ' Architect ', tier: 'sonnet' });
    expect(set.plugins.artibot.agents).toEqual({ planner: 'haiku', architect: 'sonnet' });
    const cleared = clearOverride(frozen, { scope: 'agent', plugin: 'artibot', key: 'planner' });
    expect(cleared.plugins.artibot.agents).toEqual({});
    const noop = clearOverride(frozen, { scope: 'phase', plugin: 'artibot', key: 'build' });
    expect(noop).toEqual(frozen);
    expect(noop).not.toBe(frozen);
    const def = clearOverride(setOverride(frozen, { scope: 'plugin', plugin: 'artibot', tier: 'sonnet' }), { scope: 'plugin', plugin: 'artibot' });
    expect(def.plugins.artibot.default).toBeNull();
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });

  it('resolveEffectiveModel does not mutate frozen inputs', () => {
    const opts = deepFreeze({ role: 'review' });
    const fm = deepFreeze({ planner: 'sonnet' });
    expect(() => resolveEffectiveModel('artibot:planner', opts, { config: deepFreeze(structuredClone(shippedConfig)), overrides: frozen, coworkFrontmatter: fm })).not.toThrow();
  });

  it('throws TypeError on invalid scope, plugin, key or tier', () => {
    const bad = [
      { scope: 'global', plugin: 'artibot', tier: 'opus' },
      { scope: 'plugin', plugin: 'other', tier: 'opus' },
      { scope: 'agent', plugin: 'artibot', key: 'artibot:planner', tier: 'opus' },
      { scope: 'agent', plugin: 'artibot', key: '', tier: 'opus' },
      { scope: 'agent', plugin: 'artibot', key: 'planner', tier: 'gpt' },
      { scope: 'agent', plugin: 'artibot', key: 'planner', tier: 'fable' },
      { scope: 'phase', plugin: 'artibot', key: 'deploy', tier: 'opus' },
    ];
    for (const target of bad) expect(() => setOverride(frozen, target), JSON.stringify(target)).toThrow(TypeError);
    expect(() => clearOverride(frozen, { scope: 'phase', plugin: 'artibot-cowork', key: 'build' })).toThrow(TypeError);
  });
});

describe('loadOverrides (tmp dir only)', () => {
  it('absent → emptyOverrides()', () => {
    const dir = tmpDir();
    expect(loadOverrides({ dir, config: shippedConfig })).toEqual({
      status: 'absent', overrides: emptyOverrides(), path: path.resolve(dir, OVERRIDES_FILENAME), errors: [],
    });
  });

  it('malformed JSON → malformed, overrides null', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, OVERRIDES_FILENAME), '{ not json');
    const res = loadOverrides({ dir, config: shippedConfig });
    expect(res.status).toBe('malformed');
    expect(res.overrides).toBeNull();
    expect(res.errors[0]).toMatch(/invalid JSON/);
  });

  it('invalid schema → malformed with the validation errors', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, OVERRIDES_FILENAME), JSON.stringify({ schemaVersion: 2, plugins: {} }));
    const res = loadOverrides({ dir, config: shippedConfig });
    expect(res.status).toBe('malformed');
    expect(res.overrides).toBeNull();
    expect(res.errors.join('\n')).toMatch(/schemaVersion/);
  });

  it('valid file (with BOM) → ok', () => {
    const dir = tmpDir();
    const doc = setOverride(null, { scope: 'agent', plugin: 'artibot', key: 'planner', tier: 'sonnet' });
    writeFileSync(path.join(dir, OVERRIDES_FILENAME), String.fromCharCode(0xfeff) + JSON.stringify(doc));
    const res = loadOverrides({ dir, config: shippedConfig });
    expect(res).toEqual({ status: 'ok', overrides: doc, path: path.resolve(dir, OVERRIDES_FILENAME), errors: [] });
    expect(resolveEffectiveModel('planner', {}, { config: shippedConfig, overrides: res.overrides }).model).toBe('sonnet');
  });

  it('F1: gate flipped off — a stored fable pick loads, is demoted at resolve, and keeps its neighbours', () => {
    const dir = tmpDir();
    const doc = setOverride(
      setOverride(null, { scope: 'agent', plugin: 'artibot', key: 'architect', tier: 'fable', config: gateOnConfig }),
      { scope: 'agent', plugin: 'artibot', key: 'doc-updater', tier: 'sonnet' },
    );
    writeFileSync(path.join(dir, OVERRIDES_FILENAME), JSON.stringify(doc));
    const res = loadOverrides({ dir, config: shippedConfig });
    expect(res.status).toBe('ok');
    const ctx = { config: shippedConfig, overrides: res.overrides };
    expect(resolveEffectiveModel('architect', {}, ctx))
      .toEqual(R('opus', 'override-agent', { reason: 'fable-gate', requested: 'fable', scope: 'agent' }));
    expect(resolveEffectiveModel('doc-updater', {}, ctx))
      .toEqual(R('sonnet', 'override-agent', { requested: 'sonnet', scope: 'agent' }));
    expect(() => setOverride(res.overrides, { scope: 'agent', plugin: 'artibot', key: 'architect', tier: 'fable', config: shippedConfig }))
      .toThrow(TypeError);
  });

  it('F1: a stored denylist+fable pick loads and resolves to opus/denylist; setOverride still refuses it', () => {
    const dir = tmpDir();
    const doc = { schemaVersion: 1, plugins: { artibot: { default: null, agents: { 'security-reviewer': 'fable', planner: 'haiku' }, phaseRoles: {} } } };
    writeFileSync(path.join(dir, OVERRIDES_FILENAME), JSON.stringify(doc));
    const res = loadOverrides({ dir });
    expect(res.status).toBe('ok');
    for (const config of [shippedConfig, gateOnConfig]) {
      expect(resolveEffectiveModel('security-reviewer', {}, { config, overrides: res.overrides }))
        .toEqual(R('opus', 'override-agent', { reason: 'denylist', requested: 'fable', scope: 'agent' }));
      expect(resolveEffectiveModel('planner', {}, { config, overrides: res.overrides }).model).toBe('haiku');
    }
    expect(() => setOverride(res.overrides, { scope: 'agent', plugin: 'artibot', key: 'security-reviewer', tier: 'fable', config: gateOnConfig }))
      .toThrow(/FABLE_DENYLIST/);
  });

  it('a non-vocabulary tier in the file is still malformed', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, OVERRIDES_FILENAME), JSON.stringify({ schemaVersion: 1, plugins: { artibot: { agents: { planner: 'Opus' } } } }));
    const res = loadOverrides({ dir, config: gateOnConfig });
    expect(res.status).toBe('malformed');
    expect(res.errors.join('\n')).toMatch(/tier "Opus"/);
  });

  it('a directory in place of the file → unreadable, overrides null, no throw', () => {
    const dir = tmpDir();
    mkdirSync(path.join(dir, OVERRIDES_FILENAME));
    const res = loadOverrides({ dir, config: shippedConfig });
    expect(res.status).toBe('unreadable');
    expect(res.overrides).toBeNull();
    expect(res.errors).toHaveLength(1);
  });
});

// Task layer (per-plugin `tasks`, applied only when opts.task is given). Core
// checks task keys for SHAPE only; the vocabulary (ACTION_CLASSES) and each
// agent's default task are the CLI's job, so by design a library call without
// opts.task never sees a stored task override (fail-safe).

/** Tiers per layer. Shipped for code-reviewer is opus; cowork frontmatter is opus. */
const LAYER_TIER = Object.freeze({ agent: 'haiku', task: 'sonnet', phase: 'haiku', plugin: 'sonnet' });
const CORE_AGENT = 'code-reviewer';
const COWORK_AGENT = 'case-study-writer';
const TASK_FM = Object.freeze({ [COWORK_AGENT]: 'opus' });
const TASK_OPTS = Object.freeze({ role: 'review', task: 'review' });

/** Chosen layers set in BOTH plugins via the public setters (phase: artibot only). */
function layered({ agent, task, phase, plugin }) {
  let ov = null;
  for (const p of PLUGIN_NAMES) {
    if (agent) ov = setOverride(ov, { scope: 'agent', plugin: p, key: p === 'artibot' ? CORE_AGENT : COWORK_AGENT, tier: LAYER_TIER.agent });
    if (task) ov = setOverride(ov, { scope: 'task', plugin: p, key: 'review', tier: LAYER_TIER.task });
    if (plugin) ov = setOverride(ov, { scope: 'plugin', plugin: p, tier: LAYER_TIER.plugin });
  }
  if (phase) ov = setOverride(ov, { scope: 'phase', plugin: 'artibot', key: 'review', tier: LAYER_TIER.phase });
  return ov;
}

/** Expected result for a winning layer (null = shipped / cowork frontmatter). */
function expectedFor(layer, side) {
  if (layer === null) return side === 'artibot' ? SHIPPED('opus') : R('opus', 'cowork-frontmatter', { requested: 'opus' });
  const tier = LAYER_TIER[layer];
  return R(tier, `override-${layer}`, { requested: tier, scope: layer });
}

describe('task layer — 16-row precedence matrix (agent > task > phase > plugin > shipped)', () => {
  // [agent, task, phase, plugin] present? → winning layer for artibot:code-reviewer
  // and for artibot-cowork:case-study-writer (no phase layer on cowork).
  const MATRIX = [
    [0, 0, 0, 0, null, null], /*        */ [0, 0, 0, 1, 'plugin', 'plugin'],
    [0, 0, 1, 0, 'phase', null], /*     */ [0, 0, 1, 1, 'phase', 'plugin'],
    [0, 1, 0, 0, 'task', 'task'], /*    */ [0, 1, 0, 1, 'task', 'task'],
    [0, 1, 1, 0, 'task', 'task'], /*    */ [0, 1, 1, 1, 'task', 'task'],
    [1, 0, 0, 0, 'agent', 'agent'], /*  */ [1, 0, 0, 1, 'agent', 'agent'],
    [1, 0, 1, 0, 'agent', 'agent'], /*  */ [1, 0, 1, 1, 'agent', 'agent'],
    [1, 1, 0, 0, 'agent', 'agent'], /*  */ [1, 1, 0, 1, 'agent', 'agent'],
    [1, 1, 1, 0, 'agent', 'agent'], /*  */ [1, 1, 1, 1, 'agent', 'agent'],
  ];

  it('the table is complete: 16 distinct rows', () => {
    expect(MATRIX).toHaveLength(16);
    expect(new Set(MATRIX.map((r) => r.slice(0, 4).join(''))).size).toBe(16);
  });

  for (const [a, t, p, d, core, cowork] of MATRIX) {
    it(`agent=${a} task=${t} phase=${p} plugin=${d} → ${core ?? 'shipped'} / ${cowork ?? 'frontmatter'}`, () => {
      const ctx = { config: shippedConfig, overrides: layered({ agent: a, task: t, phase: p, plugin: d }), coworkFrontmatter: TASK_FM };
      expect(resolveEffectiveModel(`artibot:${CORE_AGENT}`, TASK_OPTS, ctx)).toEqual(expectedFor(core, 'artibot'));
      expect(resolveEffectiveModel(`artibot-cowork:${COWORK_AGENT}`, TASK_OPTS, ctx)).toEqual(expectedFor(cowork, 'artibot-cowork'));
    });
  }

  it('positive control: clearing each layer in turn changes the answer', () => {
    const steps = [[null, 'agent'], [{ scope: 'agent', key: CORE_AGENT }, 'task'], [{ scope: 'task', key: 'review' }, 'phase'],
      [{ scope: 'phase', key: 'review' }, 'plugin'], [{ scope: 'plugin' }, null]];
    let ov = layered({ agent: 1, task: 1, phase: 1, plugin: 1 });
    let previous = null;
    for (const [clear, winner] of steps) {
      if (clear) ov = clearOverride(ov, { ...clear, plugin: 'artibot' });
      const got = resolveEffectiveModel(`artibot:${CORE_AGENT}`, TASK_OPTS, { config: shippedConfig, overrides: ov });
      expect(got, `after clearing ${clear?.scope}`).toEqual(expectedFor(winner, 'artibot'));
      expect(got).not.toEqual(previous);
      previous = got;
    }
  });
});

describe('task layer — 2×2: opts.task given/absent × mapped/unmapped agent', () => {
  // Only a `review` task override, both plugins. Core consults no agent→task map.
  const ov = deepFreeze(PLUGIN_NAMES.reduce((acc, p) => setOverride(acc, { scope: 'task', plugin: p, key: 'review', tier: 'haiku' }), null));
  const ctx = { config: shippedConfig, overrides: ov, coworkFrontmatter: TASK_FM };
  const TASK_HIT = R('haiku', 'override-task', { requested: 'haiku', scope: 'task' });
  const CELLS = [
    ['given', `artibot:${CORE_AGENT}`, { task: 'review' }, TASK_HIT],
    ['given', `artibot-cowork:${COWORK_AGENT}`, { task: 'review' }, TASK_HIT],
    ['absent', `artibot:${CORE_AGENT}`, {}, SHIPPED('opus')],
    ['absent', `artibot-cowork:${COWORK_AGENT}`, {}, R('opus', 'cowork-frontmatter', { requested: 'opus' })],
  ];

  for (const [mode, name, opts, expected] of CELLS) it(`opts.task ${mode}, ${name}`, () => expect(resolveEffectiveModel(name, opts, ctx)).toEqual(expected));

  it('fail-safe: a direct call without opts.task ignores a stored task override (role alone does not select it)', () => {
    expect(resolveEffectiveModel(CORE_AGENT, { role: 'review' }, ctx)).toEqual(SHIPPED(resolveModel(CORE_AGENT, { role: 'review' }, shippedConfig)));
  });

  it('empty, miscased, unknown and non-string opts.task fall through to the next layer', () => {
    for (const task of ['', 'Review', ' review', 'deploy', 42, null, ['review']]) {
      expect(resolveEffectiveModel(`artibot:${CORE_AGENT}`, { task }, ctx), JSON.stringify(task)).toEqual(SHIPPED('opus'));
    }
  });
});

describe('task layer — isolation, gates, shipped identity', () => {
  it('a cowork task override never reaches artibot, and vice versa', () => {
    const cowork = setOverride(null, { scope: 'task', plugin: 'artibot-cowork', key: 'review', tier: 'haiku' });
    const core = setOverride(null, { scope: 'task', plugin: 'artibot', key: 'review', tier: 'haiku' });
    const opts = { task: 'review' };
    expect(resolveEffectiveModel(`artibot:${CORE_AGENT}`, opts, { config: shippedConfig, overrides: cowork })).toEqual(SHIPPED('opus'));
    expect(resolveEffectiveModel(`artibot-cowork:${COWORK_AGENT}`, opts, { config: shippedConfig, overrides: cowork, coworkFrontmatter: TASK_FM }).source).toBe('override-task');
    expect(resolveEffectiveModel(`artibot-cowork:${COWORK_AGENT}`, opts, { config: shippedConfig, overrides: core, coworkFrontmatter: TASK_FM }))
      .toEqual(R('opus', 'cowork-frontmatter', { requested: 'opus' }));
    expect(resolveEffectiveModel(`artibot:${CORE_AGENT}`, opts, { config: shippedConfig, overrides: core }).source).toBe('override-task');
  });

  it('the fable gate and denylist still win after a task pick', () => {
    const ov = setOverride(null, { scope: 'task', plugin: 'artibot', key: 'review', tier: 'fable', config: gateOnConfig });
    const coworkOv = setOverride(null, { scope: 'task', plugin: 'artibot-cowork', key: 'review', tier: 'fable', config: gateOnConfig });
    const opts = { task: 'review' };
    for (const config of [shippedConfig, gateOnConfig]) {
      expect(resolveEffectiveModel('artibot:security-reviewer', opts, { config, overrides: ov }))
        .toEqual(R('opus', 'override-task', { reason: 'denylist', requested: 'fable', scope: 'task' }));
    }
    expect(resolveEffectiveModel('architect', opts, { config: gateOnConfig, overrides: ov }))
      .toEqual(R('fable', 'override-task', { requested: 'fable', scope: 'task' }));
    expect(resolveEffectiveModel('architect', opts, { config: shippedConfig, overrides: ov }))
      .toEqual(R('opus', 'override-task', { reason: 'fable-gate', requested: 'fable', scope: 'task' }));
    expect(resolveEffectiveModel('artibot-cowork:planner', opts, { config: gateOnConfig, overrides: coworkOv, coworkFrontmatter: COWORK_FM }))
      .toEqual(R('opus', 'override-task', { reason: 'fable-gate', requested: 'fable', scope: 'task' }));
  });

  it('with no override for the task, opts.task leaves every shipped answer byte-identical (6 non-canary classes)', () => {
    // classify/status are the CA-02 canary classes — pinned in model-overrides-canary.test.js.
    const plain = ACTION_CLASSES.filter((task) => !shippedConfig.routing.canary.actionClasses.includes(task));
    expect(plain).toHaveLength(6);
    const other = setOverride(null, { scope: 'task', plugin: 'artibot', key: 'implement', tier: 'haiku' });
    let checked = 0;
    for (const overrides of [null, emptyOverrides(), other]) {
      for (const agent of AGENTS) {
        for (const role of ROLE_OPTS) {
          for (const task of plain) {
            if (overrides === other && task === 'implement') continue;
            const got = resolveEffectiveModel(`artibot:${agent}`, { ...role, task }, { config: shippedConfig, overrides });
            expect(got, `${agent} ${JSON.stringify(role)} ${task}`).toEqual(SHIPPED(resolveModel(`artibot:${agent}`, role, shippedConfig)));
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(30 * 3 * 6 * 3 - 30 * 3);
  });

  it('role aliases keep their fast path even with opts.task and a matching task override', () => {
    const ov = setOverride(null, { scope: 'task', plugin: 'artibot', key: 'review', tier: 'haiku' });
    for (const alias of ['deep-async', 'frontier', 'opus']) {
      expect(resolveEffectiveModel(alias, { task: 'review' }, { config: shippedConfig, overrides: ov }))
        .toEqual(SHIPPED(resolveModel(alias, {}, shippedConfig)));
    }
  });
});

describe('task layer — setters and schema', () => {
  it('every action class is a valid task key (vocabulary ⊂ core key shape)', () => {
    expect(ACTION_CLASSES).toHaveLength(8);
    for (const task of ACTION_CLASSES) {
      const ov = setOverride(null, { scope: 'task', plugin: 'artibot-cowork', key: task, tier: 'sonnet' });
      expect(ov.plugins['artibot-cowork'].tasks).toEqual({ [task]: 'sonnet' });
      expect(validateOverrides(ov, { config: shippedConfig })).toEqual({ ok: true, errors: [] });
    }
  });

  it('setOverride rejects a malformed task key with TypeError "must be a lowercase slug"', () => {
    for (const key of ['Review', '', ' review', '1review', 'code_review', '__proto__', 'artibot:review', undefined, 42]) {
      expect(() => setOverride(null, { scope: 'task', plugin: 'artibot', key, tier: 'opus' }), JSON.stringify(key))
        .toThrow(/task key .* must be a lowercase slug/);
      expect(() => clearOverride(null, { scope: 'task', plugin: 'artibot', key }), JSON.stringify(key)).toThrow(TypeError);
    }
  });

  it('a well-formed key core does not know is accepted (vocabulary is the caller\'s check)', () => {
    expect(setOverride(null, { scope: 'task', plugin: 'artibot', key: 'deploy', tier: 'opus' }).plugins.artibot.tasks).toEqual({ deploy: 'opus' });
  });

  it('fable on a task is refused while the gate is off, by the same allowedTiersFor path as agents', () => {
    for (const config of [shippedConfig, undefined]) {
      expect(() => setOverride(null, { scope: 'task', plugin: 'artibot', key: 'review', tier: 'fable', config }))
        .toThrow(/^tier "fable" is not one of haiku\|sonnet\|opus$/);
    }
    expect(setOverride(null, { scope: 'task', plugin: 'artibot', key: 'review', tier: 'fable', config: gateOnConfig }).plugins.artibot.tasks)
      .toEqual({ review: 'fable' });
  });

  it('tasks appears only when set, and clearing the last one restores the v1 shape', () => {
    const agentOnly = setOverride(null, { scope: 'agent', plugin: 'artibot', key: 'planner', tier: 'haiku' });
    expect(Object.hasOwn(agentOnly.plugins.artibot, 'tasks')).toBe(false);
    const roundTrip = clearOverride(setOverride(agentOnly, { scope: 'task', plugin: 'artibot', key: 'review', tier: 'sonnet' }), { scope: 'task', plugin: 'artibot', key: 'review' });
    expect(JSON.stringify(roundTrip, null, 2)).toBe(JSON.stringify(agentOnly, null, 2)); // set → reset = never-tasked bytes
    const frozen = deepFreeze(setOverride(setOverride(null, { scope: 'task', plugin: 'artibot', key: 'review', tier: 'haiku' }),
      { scope: 'task', plugin: 'artibot', key: 'implement', tier: 'sonnet' }));
    const snapshot = JSON.stringify(frozen);
    const one = clearOverride(frozen, { scope: 'task', plugin: 'artibot', key: 'review' });
    expect(one.plugins.artibot.tasks).toEqual({ implement: 'sonnet' });
    const none = clearOverride(one, { scope: 'task', plugin: 'artibot', key: 'implement' });
    expect(none).toEqual(emptyOverrides());
    expect(Object.hasOwn(none.plugins.artibot, 'tasks')).toBe(false);
    expect(clearOverride(null, { scope: 'task', plugin: 'artibot-cowork', key: 'review' })).toEqual(emptyOverrides());
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });

  it('validateOverrides: tasks accepted on both plugins; bad keys, tiers and shapes rejected in both modes', () => {
    const doc = (tasks) => ({ schemaVersion: 1, plugins: { artibot: { tasks }, 'artibot-cowork': { tasks } } });
    expect(validateOverrides(doc({ review: 'haiku', 'complex-debug': 'opus' }), { config: shippedConfig })).toEqual({ ok: true, errors: [] });
    for (const mode of ['write', 'load']) {
      for (const [tasks, pattern] of [
        [{ Review: 'opus' }, /task key "Review" must be a lowercase slug/],
        [JSON.parse('{"__proto__":"opus"}'), /lowercase slug/],
        [{ review: 'Opus' }, /tier "Opus"/],
        [{ review: 'deep-async' }, /tier "deep-async"/],
        [['review'], /tasks: must be an object/],
        ['review', /tasks: must be an object/],
      ]) {
        const res = validateOverrides(doc(tasks), { config: shippedConfig, mode });
        expect(res.ok, `${mode} ${JSON.stringify(tasks)}`).toBe(false);
        expect(res.errors.join('\n')).toMatch(pattern);
      }
    }
  });

  it('validateOverrides: fable in tasks fails write with the gate off, passes load (demoted at resolve)', () => {
    const doc = { schemaVersion: 1, plugins: { artibot: { tasks: { review: 'fable' } } } };
    expect(validateOverrides(doc, { config: shippedConfig }).errors.join('\n')).toMatch(/plugins\.artibot\.tasks\.review: tier "fable"/);
    expect(validateOverrides(doc, { config: gateOnConfig }).ok).toBe(true);
    expect(validateOverrides(doc, { mode: 'load' })).toEqual({ ok: true, errors: [] });
  });
});

describe('task layer — loadOverrides (tmp dir only)', () => {
  it('a v1 file without tasks loads unchanged and gets no tasks key', () => {
    const dir = tmpDir();
    const doc = { schemaVersion: 1, plugins: { artibot: { default: 'sonnet', agents: { planner: 'haiku' }, phaseRoles: { review: 'opus' } }, 'artibot-cowork': { default: null, agents: {} } } };
    writeFileSync(path.join(dir, OVERRIDES_FILENAME), JSON.stringify(doc));
    const res = loadOverrides({ dir });
    expect(res).toEqual({ status: 'ok', overrides: doc, path: path.resolve(dir, OVERRIDES_FILENAME), errors: [] });
    expect(Object.hasOwn(res.overrides.plugins.artibot, 'tasks')).toBe(false);
    expect(resolveEffectiveModel('architect', { task: 'review' }, { config: shippedConfig, overrides: res.overrides }))
      .toEqual(R('sonnet', 'override-plugin', { requested: 'sonnet', scope: 'plugin' }));
  });

  it('an unknown but well-formed task key loads, stays inert, and keeps its neighbours', () => {
    const dir = tmpDir();
    const doc = { schemaVersion: 1, plugins: { artibot: { agents: { planner: 'haiku' }, tasks: { 'not-a-class': 'sonnet', review: 'fable' } } } };
    writeFileSync(path.join(dir, OVERRIDES_FILENAME), JSON.stringify(doc));
    const res = loadOverrides({ dir });
    expect(res.status).toBe('ok');
    const ctx = { config: shippedConfig, overrides: res.overrides };
    expect(resolveEffectiveModel('planner', { task: 'review' }, ctx)).toEqual(R('haiku', 'override-agent', { requested: 'haiku', scope: 'agent' }));
    expect(resolveEffectiveModel('architect', { task: 'implement' }, ctx)).toEqual(SHIPPED('opus'));
    expect(resolveEffectiveModel('architect', { task: 'review' }, ctx))
      .toEqual(R('opus', 'override-task', { reason: 'fable-gate', requested: 'fable', scope: 'task' }));
  });

  it('a structurally bad task entry makes the file malformed (same policy as a bad agent entry)', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, OVERRIDES_FILENAME), JSON.stringify({ schemaVersion: 1, plugins: { artibot: { agents: { planner: 'haiku' }, tasks: { Review: 'opus' } } } }));
    const res = loadOverrides({ dir });
    expect(res.status).toBe('malformed');
    expect(res.overrides).toBeNull();
    expect(res.errors.join('\n')).toMatch(/task key "Review"/);
  });
});
