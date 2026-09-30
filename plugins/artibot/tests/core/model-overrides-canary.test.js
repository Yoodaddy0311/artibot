/**
 * CA-02 — the shipped canary layer of `resolveEffectiveModel`.
 *
 * `routing.canary` ships `{ actionClasses: ['classify','status'], tier: 'sonnet' }`:
 * a spawn resolved for one of those two TASKS is answered with the low tier
 * instead of the shipped opus. It is a shipped DEFAULT of the task layer, so it
 * sits BELOW every user setting and ABOVE the shipped policy:
 *
 *   user agent > user task > user phase > user plugin default
 *     > canary (classify/status only) > shipped (resolveModel / cowork frontmatter)
 *
 * Pins: (1) positive control — the two classes really are lowered, for every
 * shipped agent that a plain (no review role, no default task) call names;
 * (2) negative control — nothing else moves (the six other classes, a call without
 * a task, an empty / unusable / tier-less canary, a call with no config);
 * (3) every user scope beats the canary and clearing that pick brings the canary
 * back; (4) the guards — a canary never RAISES a seat, never touches an alias or an
 * unknown cowork agent, and never lowers a REVIEW-side spawn, an agent whose own
 * default task is review/architecture, or an agent on its own protected list
 * (SHOULD-1: the owner's rule is design and review = opus, implementation = sonnet);
 * (5) that protected list is independent of `FABLE_DENYLIST`, in both directions.
 *
 * WHAT THIS GATE CANNOT SEE:
 *   1. Whether a leader passes `--task classify|status` — no agent DEFAULTS to
 *      those classes, so an unlabelled spawn never reaches this layer.
 *   2. Whether the host serves what was resolved (only `usage.receipt` shows that).
 *   3. The receipt path. `adaptive-model-router.js` reads the same key and records
 *      `canary:<tier>` on a `route.selected` shadow line; that is INTENT inside the
 *      policy ceiling, not this answer. The two are deliberately separate readers
 *      (`model-canary.test.js` pins that they agree on the class list).
 *   4. The CLI wiring — `tests/scripts/model-routing-canary.test.js`. This layer
 *      cannot know an agent's default task (lib/core may not import lib/routing), so
 *      it is `opts.agentTask` from the caller; the tests here inject it the way the
 *      CLI does, and a call that injects none is judged on role and name only.
 *
 * @module tests/core/model-overrides-canary
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CANARY_ACTION_CLASSES, CANARY_LOWERABLE_AGENT_CLASSES } from '../../lib/core/model-canary.js';
import { emptyOverrides, resolveEffectiveModel, setOverride } from '../../lib/core/model-overrides.js';
import { BUILD_ROLES, resolveModel, REVIEW_ROLES } from '../../lib/core/model-policy.js';
import { ACTION_CLASSES, AGENT_ACTION_CLASS } from '../../lib/routing/action-classifier.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Recursively freeze so any mutation of an input throws in strict mode. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const shippedConfig = deepFreeze(JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf8')));
const AGENTS = readdirSync(path.join(PLUGIN_ROOT, 'agents'))
  .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
  .map((f) => f.slice(0, -'.md'.length))
  .sort();
const ROLE_OPTS = Object.freeze([{}, { role: 'build' }, { role: 'review' }]);
/** The roles a canary may lower under: none, or a build word. A review word is the review guard's business. */
const LOWERABLE_ROLE_OPTS = Object.freeze([{}, { role: 'build' }]);
const NON_CANARY = Object.freeze(ACTION_CLASSES.filter((c) => !CANARY_ACTION_CLASSES.includes(c)));

/** The same shipped file with only `routing.canary` swapped. */
const withCanary = (canary) => deepFreeze({ ...structuredClone(shippedConfig), routing: { ...structuredClone(shippedConfig.routing), canary } });
/** The same shipped file with the fable kill-switch on, so fable assertions exercise an OPEN gate. */
const gateOn = (() => {
  const c = structuredClone(shippedConfig);
  c.agents.modelPolicy.fable.enabled = true;
  c.agents.modelPolicy.phaseRoles.review = 'fable';
  return deepFreeze(c);
})();

const R = (model, source, { reason = null, requested = null, scope = null } = {}) => ({ model, source, reason, requested, scope });
const SHIPPED = (model) => R(model, 'shipped');
const CANARY = (tier) => R(tier, 'canary-task');
const COWORK_FM = deepFreeze({
  planner: 'opus',
  'case-study-writer': 'haiku',
  'doc-updater': 'sonnet',
  orchestrator: 'fable',
  'content-marketer': 'opus',
  'data-analyst': 'fable',
});

/** Overrides with the given picks, via the public setter (the shape the CLI writes). */
function picks(...specs) {
  return deepFreeze(specs.reduce((doc, spec) => setOverride(doc, { config: gateOn, ...spec }), null));
}

describe('CA-02 canary layer — the shipped file arms it', () => {
  it('the premise: classify and status, onto sonnet', () => {
    expect(shippedConfig.routing.canary).toEqual({ actionClasses: ['classify', 'status'], tier: 'sonnet' });
    expect(NON_CANARY).toHaveLength(6);
  });
});

describe('CA-02 canary layer — positive control: the two classes are lowered', () => {
  const carveOut = 'security-reviewer';

  for (const task of CANARY_ACTION_CLASSES) {
    it(`${task}: all ${AGENTS.length} shipped agents × {no role, build} resolve to the canary tier when the call names no default task (the protected agent aside)`, () => {
      let lowered = 0;
      for (const agent of AGENTS) {
        for (const role of LOWERABLE_ROLE_OPTS) {
          for (const name of [agent, `artibot:${agent}`]) {
            const got = resolveEffectiveModel(name, { ...role, task }, { config: shippedConfig });
            const label = `${name} ${JSON.stringify(role)} ${task}`;
            if (agent === carveOut) {
              expect(got, label).toEqual(SHIPPED('opus'));
            } else {
              expect(got, label).toEqual(CANARY('sonnet'));
              expect(got.model, label).not.toBe(resolveModel(name, role, shippedConfig));
              lowered += 1;
            }
          }
        }
      }
      expect(lowered).toBe((AGENTS.length - 1) * 2 * 2);
    });
  }

  it('the low tier is the config key, not a constant: tier "haiku" answers haiku', () => {
    const config = withCanary({ actionClasses: ['classify', 'status'], tier: 'haiku' });
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'classify' }, { config })).toEqual(CANARY('haiku'));
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'status' }, { config })).toEqual(CANARY('haiku'));
  });

  it('each class is armed on its own', () => {
    const config = withCanary({ actionClasses: ['status'], tier: 'sonnet' });
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'status' }, { config })).toEqual(CANARY('sonnet'));
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'classify' }, { config })).toEqual(SHIPPED('opus'));
  });

  it('an artibot-cowork agent on a dearer frontmatter tier is lowered too', () => {
    const got = resolveEffectiveModel('artibot-cowork:content-marketer', { task: 'classify', agentTask: 'implement' }, { config: shippedConfig, coworkFrontmatter: COWORK_FM });
    expect(got).toEqual(CANARY('sonnet'));
  });

  it('a gate-on shipped fable seat is lowered to the canary tier as well — for a spawn the review guard lets through', () => {
    // investigator and repo-benchmarker are fable-allowlisted and default to `explore`, so the guard has no claim on them.
    for (const agent of ['investigator', 'repo-benchmarker']) {
      expect(resolveEffectiveModel(`artibot:${agent}`, {}, { config: gateOn }), agent).toEqual(SHIPPED('fable'));
      expect(resolveEffectiveModel(`artibot:${agent}`, { task: 'status', agentTask: 'explore' }, { config: gateOn }), agent).toEqual(CANARY('sonnet'));
      expect(resolveEffectiveModel(`artibot:${agent}`, { role: 'build', task: 'classify', agentTask: 'explore' }, { config: gateOn }), agent).toEqual(CANARY('sonnet'));
    }
  });

  it('a cowork frontmatter that the fable gate already demoted is lowered from the demoted tier', () => {
    // data-analyst defaults to `explore`, so the review guard has no claim on it.
    const got = resolveEffectiveModel('artibot-cowork:data-analyst', { task: 'status', agentTask: 'explore' }, { config: shippedConfig, coworkFrontmatter: COWORK_FM });
    expect(got).toEqual(CANARY('sonnet'));
  });
});

describe('CA-02 canary layer — negative control: nothing else moves', () => {
  it('the six other classes and a call without a task are shipped-identical, byte for byte', () => {
    let checked = 0;
    for (const agent of AGENTS) {
      for (const role of ROLE_OPTS) {
        for (const opts of [role, ...NON_CANARY.map((task) => ({ ...role, task }))]) {
          const got = resolveEffectiveModel(`artibot:${agent}`, opts, { config: shippedConfig });
          expect(got, `${agent} ${JSON.stringify(opts)}`).toEqual(SHIPPED(resolveModel(`artibot:${agent}`, role, shippedConfig)));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(30 * 3 * 7);
  });

  it('the same holds for artibot-cowork frontmatter answers', () => {
    for (const task of [undefined, ...NON_CANARY]) {
      for (const [agent, model] of Object.entries(COWORK_FM)) {
        const got = resolveEffectiveModel(`artibot-cowork:${agent}`, task === undefined ? {} : { task }, { config: shippedConfig, coworkFrontmatter: COWORK_FM });
        expect(got.source, `${agent} ${task}`).toBe('cowork-frontmatter');
        expect(got.requested).toBe(model);
      }
    }
  });

  it.each([
    ['an empty list (the pre-CA-02 shipped value)', { actionClasses: [], tier: 'sonnet' }],
    ['no list', { tier: 'sonnet' }],
    ['a list with a class outside the vocabulary', { actionClasses: ['explore', 'architecture', 'review'], tier: 'sonnet' }],
    ['a list with a malformed member (the WHOLE list is discarded)', { actionClasses: ['classify', 42], tier: 'sonnet' }],
    ['no tier — there is no hidden default tier', { actionClasses: ['classify', 'status'] }],
    ['a tier outside the vocabulary', { actionClasses: ['classify', 'status'], tier: 'opus' }],
    ['a fable tier', { actionClasses: ['classify', 'status'], tier: 'fable' }],
    ['a null canary', null],
  ])('%s arms nothing', (_label, canary) => {
    const config = withCanary(canary);
    for (const task of CANARY_ACTION_CLASSES) {
      expect(resolveEffectiveModel('artibot:doc-updater', { task }, { config })).toEqual(SHIPPED('opus'));
      expect(resolveEffectiveModel('artibot-cowork:planner', { task }, { config, coworkFrontmatter: COWORK_FM }).source).toBe('cowork-frontmatter');
    }
  });

  it('a config without a routing block, and no config at all, arm nothing', () => {
    const { routing: _routing, ...noRouting } = structuredClone(shippedConfig);
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'classify' }, { config: noRouting })).toEqual(SHIPPED('opus'));
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'classify' }, {})).toEqual(
      SHIPPED(resolveModel('artibot:doc-updater', {}, undefined)),
    );
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'classify' })).toEqual(
      SHIPPED(resolveModel('artibot:doc-updater', {}, undefined)),
    );
  });

  it('opts that are not a plain object, or a task that is not exactly a class word, arm nothing', () => {
    for (const opts of [null, undefined, 'classify', 42, ['classify']]) {
      expect(resolveEffectiveModel('artibot:doc-updater', opts, { config: shippedConfig }), String(opts)).toEqual(SHIPPED('opus'));
    }
    for (const task of ['', ' classify', 'Classify', 'CLASSIFY', 'classify ', 42, null, ['classify'], { task: 'classify' }, 'complex-debugging']) {
      expect(resolveEffectiveModel('artibot:doc-updater', { task }, { config: shippedConfig }), JSON.stringify(task)).toEqual(SHIPPED('opus'));
    }
  });

  it('role aliases and tier words keep their fast path — a canary is a task-layer answer for an AGENT', () => {
    for (const alias of ['deep-async', 'frontier', 'opus', 'artibot:deep-async']) {
      for (const task of CANARY_ACTION_CLASSES) {
        expect(resolveEffectiveModel(alias, { task }, { config: shippedConfig })).toEqual(SHIPPED(resolveModel(alias, {}, shippedConfig)));
      }
    }
  });

  it('an unparseable or unknown-frontmatter cowork name has nothing to lower', () => {
    for (const name of ['artibot-cowork:', 'artibot-cowork:a:b']) {
      expect(resolveEffectiveModel(name, { task: 'classify' }, { config: shippedConfig, coworkFrontmatter: COWORK_FM }).model, name).toBeNull();
    }
    const unknown = resolveEffectiveModel('artibot-cowork:no-such-agent', { task: 'classify' }, { config: shippedConfig, coworkFrontmatter: COWORK_FM });
    expect(unknown).toEqual(R(null, 'cowork-frontmatter-unknown'));
  });
});

describe('CA-02 canary layer — the user always wins', () => {
  const ctx = (overrides) => ({ config: shippedConfig, overrides, coworkFrontmatter: COWORK_FM });
  const name = 'artibot:doc-updater';

  it('positive control: with no user pick the canary answers (so each win below means something)', () => {
    expect(resolveEffectiveModel(name, { task: 'classify' }, ctx(emptyOverrides()))).toEqual(CANARY('sonnet'));
    expect(resolveEffectiveModel(name, { task: 'classify' }, ctx(null))).toEqual(CANARY('sonnet'));
  });

  it('a user AGENT pick beats it', () => {
    const overrides = picks({ scope: 'agent', plugin: 'artibot', key: 'doc-updater', tier: 'opus' });
    expect(resolveEffectiveModel(name, { task: 'classify' }, ctx(overrides))).toEqual(R('opus', 'override-agent', { requested: 'opus', scope: 'agent' }));
  });

  it('a user TASK pick beats it — for the class it names, and only that class', () => {
    const overrides = picks({ scope: 'task', plugin: 'artibot', key: 'classify', tier: 'opus' });
    expect(resolveEffectiveModel(name, { task: 'classify' }, ctx(overrides))).toEqual(R('opus', 'override-task', { requested: 'opus', scope: 'task' }));
    expect(resolveEffectiveModel(name, { task: 'status' }, ctx(overrides))).toEqual(CANARY('sonnet'));
  });

  it('a user TASK pick BELOW the canary is honoured too (the user may go cheaper than the default)', () => {
    const overrides = picks({ scope: 'task', plugin: 'artibot', key: 'status', tier: 'haiku' });
    expect(resolveEffectiveModel(name, { task: 'status' }, ctx(overrides))).toEqual(R('haiku', 'override-task', { requested: 'haiku', scope: 'task' }));
  });

  it('a user PHASE pick beats it, but only when the spawn carries that role', () => {
    const overrides = picks({ scope: 'phase', plugin: 'artibot', key: 'build', tier: 'opus' });
    expect(resolveEffectiveModel(name, { role: 'build', task: 'classify' }, ctx(overrides))).toEqual(R('opus', 'override-phase', { requested: 'opus', scope: 'phase' }));
    // The review role carries no build pick, and the review guard keeps the canary off it: the shipped policy answers.
    expect(resolveEffectiveModel(name, { role: 'review', task: 'classify' }, ctx(overrides))).toEqual(SHIPPED('opus'));
    expect(resolveEffectiveModel(name, { task: 'classify' }, ctx(overrides))).toEqual(CANARY('sonnet'));
  });

  it('a user PLUGIN default beats it', () => {
    const overrides = picks({ scope: 'plugin', plugin: 'artibot', tier: 'opus' });
    expect(resolveEffectiveModel(name, { task: 'status' }, ctx(overrides))).toEqual(R('opus', 'override-plugin', { requested: 'opus', scope: 'plugin' }));
  });

  it('a user pick that equals the canary tier is still reported as the USER pick', () => {
    const overrides = picks({ scope: 'task', plugin: 'artibot', key: 'classify', tier: 'sonnet' });
    expect(resolveEffectiveModel(name, { task: 'classify' }, ctx(overrides))).toEqual(R('sonnet', 'override-task', { requested: 'sonnet', scope: 'task' }));
  });

  it('a user pick the fable gate demotes still wins (the demoted value, not the canary)', () => {
    const overrides = picks({ scope: 'task', plugin: 'artibot', key: 'classify', tier: 'fable' });
    expect(resolveEffectiveModel(name, { task: 'classify' }, ctx(overrides)))
      .toEqual(R('opus', 'override-task', { reason: 'fable-gate', requested: 'fable', scope: 'task' }));
  });

  it('cowork: a user pick on the cowork side beats it; a pick on the OTHER plugin does not reach it', () => {
    const cowork = picks({ scope: 'task', plugin: 'artibot-cowork', key: 'classify', tier: 'opus' });
    expect(resolveEffectiveModel('artibot-cowork:planner', { task: 'classify' }, ctx(cowork))).toEqual(R('opus', 'override-task', { requested: 'opus', scope: 'task' }));
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'classify' }, ctx(cowork))).toEqual(CANARY('sonnet'));
    const core = picks({ scope: 'task', plugin: 'artibot', key: 'classify', tier: 'opus' });
    expect(resolveEffectiveModel('artibot-cowork:planner', { task: 'classify' }, ctx(core))).toEqual(CANARY('sonnet'));
  });

  it('all four scopes × both classes: exactly one layer answers, and it is never the canary', () => {
    const scopes = [
      { scope: 'agent', plugin: 'artibot', key: 'doc-updater' },
      { scope: 'task', plugin: 'artibot', key: null },
      { scope: 'phase', plugin: 'artibot', key: 'build' },
      { scope: 'plugin', plugin: 'artibot' },
    ];
    for (const task of CANARY_ACTION_CLASSES) {
      for (const spec of scopes) {
        const overrides = picks({ ...spec, ...(spec.scope === 'task' ? { key: task } : {}), tier: 'opus' });
        const got = resolveEffectiveModel(name, { role: 'build', task }, ctx(overrides));
        expect(got.source, `${spec.scope} ${task}`).toBe(`override-${spec.scope}`);
        expect(got.model).toBe('opus');
      }
    }
  });
});

describe('CA-02 canary layer — guards', () => {
  it('never RAISES a seat: a cowork frontmatter already at or below the canary tier is left alone', () => {
    const ctx = { config: shippedConfig, coworkFrontmatter: COWORK_FM };
    // haiku is cheaper than the canary's sonnet: the canary must not lift it.
    expect(resolveEffectiveModel('artibot-cowork:case-study-writer', { task: 'classify' }, ctx))
      .toEqual(R('haiku', 'cowork-frontmatter', { requested: 'haiku' }));
    // equal: not "lowered" either — the answer stays the frontmatter's, source and all.
    expect(resolveEffectiveModel('artibot-cowork:doc-updater', { task: 'status' }, ctx))
      .toEqual(R('sonnet', 'cowork-frontmatter', { requested: 'sonnet' }));
  });

  it('never raises an artibot seat either: a policy that already answers haiku stays haiku', () => {
    const cheap = structuredClone(shippedConfig);
    cheap.agents.modelPolicy.high.model = 'haiku';
    cheap.agents.modelPolicy.medium.model = 'haiku';
    deepFreeze(cheap);
    expect(resolveModel('artibot:doc-updater', {}, cheap)).toBe('haiku');
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'classify' }, { config: cheap })).toEqual(SHIPPED('haiku'));
  });

  it('security-reviewer is on the canary\'s own protected list — never moved, whatever the call names (the name-only floor)', () => {
    for (const config of [shippedConfig, gateOn]) {
      for (const task of CANARY_ACTION_CLASSES) {
        for (const name of ['security-reviewer', 'artibot:security-reviewer', 'artibot:Security-Reviewer']) {
          expect(resolveEffectiveModel(name, { task }, { config }), `${name} ${task}`).toEqual(SHIPPED('opus'));
          expect(resolveEffectiveModel(name, { role: 'build', task, agentTask: 'implement' }, { config }), `${name} ${task} build`).toEqual(SHIPPED('opus'));
        }
      }
    }
    // Positive control: the same call for an unprotected agent IS lowered.
    expect(resolveEffectiveModel('artibot:doc-updater', { task: 'classify' }, { config: shippedConfig })).toEqual(CANARY('sonnet'));
  });

  it('...but an EXPLICIT user pick still moves it (the carve-out guards the shipped default only)', () => {
    const overrides = picks({ scope: 'task', plugin: 'artibot', key: 'classify', tier: 'sonnet' });
    expect(resolveEffectiveModel('artibot:security-reviewer', { task: 'classify' }, { config: shippedConfig, overrides }))
      .toEqual(R('sonnet', 'override-task', { requested: 'sonnet', scope: 'task' }));
  });

  it('a canary answer is a fresh object each call and never mutates its inputs', () => {
    const overrides = deepFreeze(emptyOverrides());
    const a = resolveEffectiveModel('artibot:doc-updater', { task: 'classify' }, { config: shippedConfig, overrides });
    const b = resolveEffectiveModel('artibot:doc-updater', { task: 'classify' }, { config: shippedConfig, overrides });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(false);
  });

  it('the canary tier is always one of the two the vocabulary allows', () => {
    const seen = new Set();
    for (const agent of AGENTS) {
      for (const task of CANARY_ACTION_CLASSES) {
        const got = resolveEffectiveModel(`artibot:${agent}`, { task }, { config: shippedConfig });
        if (got.source === 'canary-task') seen.add(got.model);
      }
    }
    expect([...seen]).toEqual(['sonnet']);
  });
});

describe('CA-02 canary layer — the review guard: design and review stay on the shipped tier (SHOULD-1)', () => {
  // The owner's rule (2026-09-29): design and review = opus, implementation = sonnet. The canary is a cost lever for
  // spawns that are genuinely classify/status work, so it may lower a seat only when ALL of these hold:
  //   the role is absent or a build word  ∧  the agent's OWN default task is not review/architecture  ∧
  //   the agent is off the canary's protected list.
  // Before the guard, `code-reviewer --role review --task status` printed sonnet.
  const ctx = (overrides) => ({ config: shippedConfig, overrides, coworkFrontmatter: COWORK_FM });

  it.each([...REVIEW_ROLES])('role %s: every shipped agent × both classes is answered by the shipped policy, never the canary', (role) => {
    let checked = 0;
    for (const agent of AGENTS) {
      for (const task of CANARY_ACTION_CLASSES) {
        const got = resolveEffectiveModel(`artibot:${agent}`, { role, task }, { config: shippedConfig });
        expect(got, `${agent} ${role} ${task}`).toEqual(SHIPPED(resolveModel(`artibot:${agent}`, { role }, shippedConfig)));
        checked += 1;
      }
    }
    expect(checked).toBe(AGENTS.length * CANARY_ACTION_CLASSES.length);
  });

  it.each([...BUILD_ROLES])('role %s is lowered exactly like no role (positive control for the guard above)', (role) => {
    for (const task of CANARY_ACTION_CLASSES) {
      expect(resolveEffectiveModel('artibot:doc-updater', { role, task }, { config: shippedConfig }), task).toEqual(CANARY('sonnet'));
    }
  });

  it('an unknown role word is not lowered: planning and design are exactly the roles the owner keeps on opus', () => {
    for (const role of ['planning', 'design', 'Build', 'REVIEW']) {
      expect(resolveEffectiveModel('artibot:doc-updater', { role, task: 'status' }, { config: shippedConfig }), role).toEqual(SHIPPED('opus'));
    }
  });

  it('a gate-on fable seat under a review role is NOT lowered — the review tier is what the gate is for', () => {
    expect(resolveEffectiveModel('artibot:code-reviewer', { role: 'review' }, { config: gateOn })).toEqual(SHIPPED('fable'));
    expect(resolveEffectiveModel('artibot:code-reviewer', { role: 'review', task: 'classify' }, { config: gateOn })).toEqual(SHIPPED('fable'));
    expect(resolveEffectiveModel('artibot:code-reviewer', { role: 'review', task: 'status', agentTask: 'review' }, { config: gateOn })).toEqual(SHIPPED('fable'));
  });

  it('an agent whose default task is review or architecture is not lowered, under any role — the CLI\'s injection, all 30 agents', () => {
    let held = 0;
    let lowered = 0;
    for (const agent of AGENTS) {
      const agentTask = AGENT_ACTION_CLASS[agent];
      expect(typeof agentTask, `${agent} has a default task`).toBe('string');
      for (const role of ROLE_OPTS) {
        for (const task of CANARY_ACTION_CLASSES) {
          const got = resolveEffectiveModel(`artibot:${agent}`, { ...role, task, agentTask }, { config: shippedConfig });
          const label = `${agent} [${agentTask}] ${JSON.stringify(role)} ${task}`;
          const stays = !CANARY_LOWERABLE_AGENT_CLASSES.includes(agentTask) || role.role === 'review' || agent === 'security-reviewer';
          expect(got, label).toEqual(stays ? SHIPPED('opus') : CANARY('sonnet'));
          if (stays) held += 1;
          else lowered += 1;
        }
      }
    }
    expect(held + lowered).toBe(AGENTS.length * ROLE_OPTS.length * CANARY_ACTION_CLASSES.length);
    // Neither side is empty, so the split above is not a vacuous pass.
    expect(lowered).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(0);
  });

  it('spot checks, written out: reviewers and designers stay, builders are lowered', () => {
    for (const [agent, agentTask] of [['code-reviewer', 'review'], ['spec-reviewer', 'review'], ['auditor', 'review'], ['architect', 'architecture'], ['planner', 'architecture'], ['orchestrator', 'architecture']]) {
      for (const task of CANARY_ACTION_CLASSES) {
        expect(resolveEffectiveModel(`artibot:${agent}`, { task, agentTask }, { config: shippedConfig }), `${agent} ${task}`).toEqual(SHIPPED('opus'));
        expect(resolveEffectiveModel(`artibot:${agent}`, { role: 'build', task, agentTask }, { config: shippedConfig }), `${agent} build ${task}`).toEqual(SHIPPED('opus'));
      }
    }
    for (const [agent, agentTask] of [['doc-updater', 'edit-routine'], ['backend-developer', 'implement'], ['tdd-guide', 'implement'], ['build-error-resolver', 'complex-debug'], ['investigator', 'explore']]) {
      for (const task of CANARY_ACTION_CLASSES) {
        expect(resolveEffectiveModel(`artibot:${agent}`, { task, agentTask }, { config: shippedConfig }), `${agent} ${task}`).toEqual(CANARY('sonnet'));
      }
    }
  });

  it('cowork agents are guarded the same way: a design agent keeps its frontmatter tier, a builder is lowered', () => {
    const cowork = { config: shippedConfig, coworkFrontmatter: COWORK_FM };
    expect(resolveEffectiveModel('artibot-cowork:planner', { task: 'classify', agentTask: 'architecture' }, cowork)).toEqual(R('opus', 'cowork-frontmatter', { requested: 'opus' }));
    expect(resolveEffectiveModel('artibot-cowork:planner', { role: 'review', task: 'status' }, cowork)).toEqual(R('opus', 'cowork-frontmatter', { requested: 'opus' }));
    expect(resolveEffectiveModel('artibot-cowork:content-marketer', { role: 'build', task: 'status', agentTask: 'implement' }, cowork)).toEqual(CANARY('sonnet'));
  });

  it('agentTask by itself moves nothing: no task, or a task the canary does not name, answers the shipped policy', () => {
    let checked = 0;
    for (const agent of AGENTS) {
      for (const agentTask of [undefined, null, ...ACTION_CLASSES]) {
        for (const role of ROLE_OPTS) {
          for (const opts of [{}, ...NON_CANARY.map((task) => ({ task }))]) {
            const got = resolveEffectiveModel(`artibot:${agent}`, { ...role, ...opts, agentTask }, { config: shippedConfig });
            expect(got, `${agent} ${agentTask} ${JSON.stringify({ ...role, ...opts })}`).toEqual(SHIPPED(resolveModel(`artibot:${agent}`, role, shippedConfig)));
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(AGENTS.length * (ACTION_CLASSES.length + 2) * ROLE_OPTS.length * (NON_CANARY.length + 1));
  });

  it('a default task that is not EXACTLY one of the six fails closed; none / undefined mean "no default task" and are lowered', () => {
    const opts = (agentTask) => ({ task: 'status', agentTask });
    // A near miss of a protected class, an unknown word and a non-string are all "cannot show it is lowerable".
    for (const agentTask of ['Review', ' architecture ', 'ARCHITECTURE', 'Implement', 'no-such-class', 42, {}, ['review']]) {
      expect(resolveEffectiveModel('artibot:doc-updater', opts(agentTask), { config: shippedConfig }), JSON.stringify(agentTask)).toEqual(SHIPPED('opus'));
    }
    for (const agentTask of [undefined, null, 'implement', 'edit-routine']) {
      expect(resolveEffectiveModel('artibot:doc-updater', opts(agentTask), { config: shippedConfig }), String(agentTask)).toEqual(CANARY('sonnet'));
    }
  });

  it('the guard limits the CANARY, not the user: an explicit pick still reaches a review-side spawn', () => {
    const task = picks({ scope: 'task', plugin: 'artibot', key: 'status', tier: 'sonnet' });
    expect(resolveEffectiveModel('artibot:code-reviewer', { role: 'review', task: 'status', agentTask: 'review' }, ctx(task)))
      .toEqual(R('sonnet', 'override-task', { requested: 'sonnet', scope: 'task' }));
    const agent = picks({ scope: 'agent', plugin: 'artibot', key: 'planner', tier: 'haiku' });
    expect(resolveEffectiveModel('artibot:planner', { task: 'classify', agentTask: 'architecture' }, ctx(agent)))
      .toEqual(R('haiku', 'override-agent', { requested: 'haiku', scope: 'agent' }));
    const plugin = picks({ scope: 'plugin', plugin: 'artibot', tier: 'sonnet' });
    expect(resolveEffectiveModel('artibot:architect', { task: 'status', agentTask: 'architecture' }, ctx(plugin)))
      .toEqual(R('sonnet', 'override-plugin', { requested: 'sonnet', scope: 'plugin' }));
    const phase = picks({ scope: 'phase', plugin: 'artibot', key: 'review', tier: 'haiku' });
    expect(resolveEffectiveModel('artibot:code-reviewer', { role: 'review', task: 'classify', agentTask: 'review' }, ctx(phase)))
      .toEqual(R('haiku', 'override-phase', { requested: 'haiku', scope: 'phase' }));
  });
});

describe('CA-02 canary layer — the protected agents are independent of FABLE_DENYLIST', () => {
  afterEach(() => {
    vi.doUnmock('../../lib/core/model-policy.js');
    vi.resetModules();
  });

  /**
   * `resolveEffectiveModel` from a fresh module graph in which `model-policy.js` exports the given FABLE_DENYLIST.
   * The rest of that module is the real one, so the fable gate and `resolveModel` behave as shipped.
   */
  async function withDenylist(denylist) {
    vi.resetModules();
    vi.doMock('../../lib/core/model-policy.js', async (importOriginal) => ({
      ...(await importOriginal()),
      FABLE_DENYLIST: Object.freeze([...denylist]),
    }));
    return (await import('../../lib/core/model-overrides.js')).resolveEffectiveModel;
  }

  it('the mock is live: model-overrides reads the swapped list for its OWN use (a user fable pick is demoted with reason denylist)', async () => {
    const overrides = picks({ scope: 'agent', plugin: 'artibot', key: 'doc-updater', tier: 'fable' });
    const real = resolveEffectiveModel('artibot:doc-updater', {}, { config: gateOn, overrides });
    expect(real).toEqual(R('opus', 'override-agent', { reason: 'fable-gate', requested: 'fable', scope: 'agent' }));
    const resolve = await withDenylist(['doc-updater']);
    expect(resolve('artibot:doc-updater', {}, { config: gateOn, overrides }))
      .toEqual(R('opus', 'override-agent', { reason: 'denylist', requested: 'fable', scope: 'agent' }));
  });

  it('emptying FABLE_DENYLIST does not unprotect security-reviewer', async () => {
    const resolve = await withDenylist([]);
    for (const task of CANARY_ACTION_CLASSES) {
      expect(resolve('artibot:security-reviewer', { task }, { config: shippedConfig }), task).toEqual(SHIPPED('opus'));
    }
    // Positive control: the canary is on in that same graph, so the line above holds for the right reason.
    expect(resolve('artibot:doc-updater', { task: 'classify' }, { config: shippedConfig })).toEqual(CANARY('sonnet'));
  });

  it('adding an agent to FABLE_DENYLIST does not protect it from the canary', async () => {
    const resolve = await withDenylist(['doc-updater', 'artibot:doc-updater']);
    for (const task of CANARY_ACTION_CLASSES) {
      expect(resolve('artibot:doc-updater', { task }, { config: shippedConfig }), task).toEqual(CANARY('sonnet'));
    }
  });
});

describe('CA-02 canary layer — the shipped answer never sees the task context', () => {
  afterEach(() => {
    vi.doUnmock('../../lib/core/model-policy.js');
    vi.resetModules();
  });

  it('resolveModel is handed neither `task` nor `agentTask`, whatever the canary decides', async () => {
    const seen = [];
    vi.resetModules();
    vi.doMock('../../lib/core/model-policy.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        resolveModel: (name, opts, config) => {
          seen.push(opts);
          return actual.resolveModel(name, opts, config);
        },
      };
    });
    const { resolveEffectiveModel: resolve } = await import('../../lib/core/model-overrides.js');
    const calls = [
      ['artibot:doc-updater', { role: 'build', task: 'status', agentTask: 'edit-routine' }],
      ['artibot:code-reviewer', { role: 'review', task: 'classify', agentTask: 'review' }],
      ['artibot:planner', { task: 'explore', agentTask: 'architecture' }],
      ['deep-async', { task: 'status', agentTask: 'implement' }],
    ];
    for (const [name, opts] of calls) resolve(name, opts, { config: shippedConfig });
    expect(seen).toHaveLength(calls.length);
    for (const [i, opts] of seen.entries()) {
      expect(Object.keys(opts).sort(), calls[i][0]).toEqual(Object.keys(calls[i][1]).filter((k) => k === 'role'));
    }
  });
});
