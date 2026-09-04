/**
 * `allowedTiers()` — the policy CEILING, not the pick (design §3.2 "정책과
 * 선택의 분리", lane-2 routing contract §2.2). `lib/routing/` must choose
 * inside this set and be structurally unable to choose outside it, so the
 * invariant these tests pin is: the set is always a superset of what
 * `resolveModel` picks today, and `FABLE_DENYLIST` caps it at opus.
 *
 * WHAT THESE TESTS DO NOT SEE:
 *   - That any caller actually restricts itself to the set. No `lib/routing/`
 *     consumer exists as of 2026-09-02; T-29 owns that wiring and its own gate.
 *   - Whether the host's Agent `model` parameter accepts a tier alias — the set
 *     is advisory data until a spawn call passes it (lane-2 §4.2-3, unverified).
 *   - Real fable behavior or cost. These are pure config-resolution assertions.
 *   - `resolveModel`'s own byte-identical contract; that is pinned by the
 *     untouched tests/core/model-policy.test.js and
 *     tests/firewall/v5-config-firewall.test.js, not here.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listTiers } from '../../lib/core/model-catalog.js';
import {
  allowedTiers,
  BUILD_ROLES,
  FABLE_DENYLIST,
  resolveModel,
  REVIEW_ROLES,
} from '../../lib/core/model-policy.js';

// Read the real config so every expectation is DERIVED, never hardcoded.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', '..', 'artibot.config.json');
const realConfig = JSON.parse(await readFile(configPath, 'utf8'));
const policy = realConfig.agents.modelPolicy;

const highAgents = policy.high.agents;
const mediumAgents = policy.medium.agents;
/** Full shipped roster (30 agents on 2026-09-04; the count is derived, not pinned here). */
const allAgents = [...highAgents, ...mediumAgents];
const fableAllowlist = policy.fable.allowlist;
const notAllowlisted = allAgents.filter((a) => !fableAllowlist.includes(a));

/**
 * Every phase role `resolveModel` understands, plus the no-role case. Derived
 * from the exported sets so this file does not mirror the vocabulary either.
 */
const ROLE_CASES = [
  {},
  ...[...BUILD_ROLES, ...REVIEW_ROLES].map((role) => ({ role })),
];

/** Sorted array form, so assertions read as sets and not as iteration order. */
const tiersOf = (agent, opts = {}, config = realConfig) =>
  [...allowedTiers(agent, opts, config)].sort();

/** Deep clone of the shipped config for negative and hypothetical cases. */
const cloneConfig = () => structuredClone(realConfig);

describe('allowedTiers()', () => {
  describe('phase-role vocabulary exports (T-27 anti-drift)', () => {
    it('exposes BUILD_ROLES and REVIEW_ROLES with their existing values', () => {
      expect(BUILD_ROLES).toBeInstanceOf(Set);
      expect(REVIEW_ROLES).toBeInstanceOf(Set);
      // Literal values, unchanged by the export promotion. These are the only
      // hardcoded copies in the repo — every other module must import them.
      expect([...BUILD_ROLES].sort()).toEqual(['build', 'impl', 'implementation']);
      expect([...REVIEW_ROLES].sort()).toEqual(['crosscheck', 'inspect', 'review']);
      // The literals only mean something if resolveModel still routes by them:
      // an allowlisted agent lands on phaseRoles.build for every build role and
      // on phaseRoles.review for every review role.
      for (const role of BUILD_ROLES) {
        expect(resolveModel('architect', { role }, realConfig)).toBe(
          policy.phaseRoles.build,
        );
      }
      for (const role of REVIEW_ROLES) {
        expect(resolveModel('architect', { role }, realConfig)).toBe(
          policy.phaseRoles.review,
        );
      }
      // Disjoint, or the build/review mapping above would be ambiguous.
      expect([...BUILD_ROLES].filter((r) => REVIEW_ROLES.has(r))).toEqual([]);
    });
  });
  describe('superset invariant (all shipped agents)', () => {
    it('always contains the tier resolveModel picks, for every role', () => {
      const violations = [];
      for (const agent of allAgents) {
        for (const opts of ROLE_CASES) {
          const picked = resolveModel(agent, opts, realConfig);
          if (!allowedTiers(agent, opts, realConfig).has(picked)) {
            violations.push(`${agent} ${JSON.stringify(opts)} -> ${picked}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });

    it('always contains opus, the universal fallback tier', () => {
      const missing = allAgents.filter(
        (agent) => !allowedTiers(agent, {}, realConfig).has('opus'),
      );
      expect(missing).toEqual([]);
    });

    it('covers the whole roster (high + medium buckets, no duplicates)', () => {
      expect(allAgents.length).toBe(highAgents.length + mediumAgents.length);
      expect(new Set(allAgents).size).toBe(allAgents.length);
    });
  });

  describe('shipped config — 2-tier fleet', () => {
    it.each(fableAllowlist)(
      '%s (allowlisted) ceiling is fable + opus',
      (agent) => {
        expect(tiersOf(agent)).toEqual(['fable', 'opus']);
      },
    );

    it.each(notAllowlisted)(
      '%s (not allowlisted) ceiling is opus only',
      (agent) => {
        expect(tiersOf(agent)).toEqual(['opus']);
      },
    );

    it('allowlist is the ONLY set that reaches fable, despite high.model=fable', () => {
      expect(policy.high.model).toBe('fable');
      const reachFable = allAgents.filter((a) =>
        allowedTiers(a, {}, realConfig).has('fable'),
      );
      expect(reachFable.sort()).toEqual([...fableAllowlist].sort());
    });

    it('never offers sonnet or haiku — the low bucket is empty', () => {
      expect(policy.low.agents).toEqual([]);
      const widened = allAgents.filter((a) => {
        const set = allowedTiers(a, {}, realConfig);
        return set.has('sonnet') || set.has('haiku');
      });
      expect(widened).toEqual([]);
    });
  });

  describe('FABLE_DENYLIST is a hard ceiling', () => {
    const denied = FABLE_DENYLIST.map((n) => n.replace(/^artibot:/, ''));

    it.each(denied)(
      '%s cannot reach fable under the shipped config',
      (agent) => {
        expect(allowedTiers(agent, {}, realConfig).has('fable')).toBe(false);
      },
    );

    it.each(denied)(
      '%s cannot reach fable even when allowlisted AND declared low:fable',
      (agent) => {
        const config = cloneConfig();
        config.agents.modelPolicy.fable.allowlist.push(agent);
        config.agents.modelPolicy.low = { model: 'fable', agents: [agent] };
        expect(allowedTiers(agent, {}, config).has('fable')).toBe(false);
        expect(tiersOf(agent, {}, config)).toEqual(['opus']);
      },
    );

    it.each(denied)('%s stays opus-capped under every phase role', (agent) => {
      for (const opts of ROLE_CASES) {
        expect(tiersOf(agent, opts)).toEqual(['opus']);
      }
    });
  });

  describe('role changes the default pick, never the ceiling', () => {
    it('a non-allowlisted agent in the fable review phase still gets opus only', () => {
      expect(policy.phaseRoles.review).toBe('fable');
      expect(tiersOf('backend-developer', { role: 'review' })).toEqual(['opus']);
    });

    it('an allowlisted agent keeps its fable ceiling in the opus build phase', () => {
      expect(policy.phaseRoles.build).toBe('opus');
      expect(resolveModel('code-reviewer', { role: 'build' }, realConfig)).toBe(
        'opus',
      );
      expect(tiersOf('code-reviewer', { role: 'build' })).toEqual([
        'fable',
        'opus',
      ]);
    });

    it('an unknown role is ignored, same as no role', () => {
      expect(tiersOf('architect', { role: 'mystery' })).toEqual(
        tiersOf('architect', {}),
      );
    });
  });

  describe('low bucket widens the ceiling — clone only, real config untouched', () => {
    it('adds sonnet for an agent listed under low', () => {
      const config = cloneConfig();
      config.agents.modelPolicy.low = {
        model: 'sonnet',
        agents: ['architect'],
      };
      expect(tiersOf('architect', {}, config)).toEqual([
        'fable',
        'opus',
        'sonnet',
      ]);
    });

    it('resolves a role alias declared as the low model', () => {
      const config = cloneConfig();
      config.agents.modelPolicy.low = { model: 'fast', agents: ['doc-updater'] };
      expect(tiersOf('doc-updater', {}, config)).toEqual(['haiku', 'opus']);
    });

    it('drops a low model the catalog cannot resolve', () => {
      const config = cloneConfig();
      config.agents.modelPolicy.low = {
        model: 'gpt-5',
        agents: ['doc-updater'],
      };
      expect(tiersOf('doc-updater', {}, config)).toEqual(['opus']);
    });

    it('still gates a low bucket that declares fable for a non-allowlisted agent', () => {
      const config = cloneConfig();
      config.agents.modelPolicy.low = {
        model: 'fable',
        agents: ['backend-developer'],
      };
      expect(tiersOf('backend-developer', {}, config)).toEqual(['opus']);
    });

    it('the SHIPPED config gains nothing from low — the clone is the only widening', () => {
      expect(tiersOf('architect')).toEqual(['fable', 'opus']);
      expect(tiersOf('doc-updater')).toEqual(['opus']);
      // The on-disk config still has the empty-bucket shape the clones mutated.
      expect(realConfig.agents.modelPolicy.low.agents).toEqual([]);
      expect(realConfig.agents.modelPolicy.low.model).toBe('sonnet');
    });

    it('does not mutate the config object it is given', () => {
      const config = cloneConfig();
      const snapshot = JSON.stringify(config);
      for (const agent of allAgents) {
        allowedTiers(agent, { role: 'review' }, config);
      }
      expect(JSON.stringify(config)).toBe(snapshot);
    });
  });

  describe('kill-switch', () => {
    it('collapses every agent to opus when fable.enabled is false', () => {
      const config = cloneConfig();
      config.agents.modelPolicy.fable.enabled = false;
      const widened = allAgents.filter((a) =>
        allowedTiers(a, {}, config).has('fable'),
      );
      expect(widened).toEqual([]);
    });
  });

  describe('input handling', () => {
    it('normalizes plugin-prefixed and padded names', () => {
      expect(tiersOf('artibot:architect')).toEqual(tiersOf('architect'));
      expect(tiersOf('  architect  ')).toEqual(tiersOf('architect'));
      expect(tiersOf('artibot-cowork:doc-updater')).toEqual(
        tiersOf('doc-updater'),
      );
    });

    it('returns opus for an unknown agent instead of throwing', () => {
      expect(tiersOf('nobody-at-all')).toEqual(['opus']);
    });

    it.each([42, null, undefined, {}, []])(
      'returns a non-empty opus set for non-string input %p',
      (bad) => {
        expect(tiersOf(bad)).toEqual(['opus']);
      },
    );

    it('tolerates a missing or malformed opts argument', () => {
      expect([...allowedTiers('architect', null, realConfig)].sort()).toEqual([
        'fable',
        'opus',
      ]);
      expect([...allowedTiers('architect', 'nope', realConfig)].sort()).toEqual([
        'fable',
        'opus',
      ]);
    });

    it('tolerates a config with no modelPolicy at all', () => {
      expect(tiersOf('architect', {}, {})).toEqual(['opus']);
      expect(tiersOf('architect', {}, { agents: {} })).toEqual(['opus']);
    });

    it('honors a role alias passed as the agent (kill-switch path)', () => {
      expect(tiersOf('deep-async')).toEqual(['fable', 'opus']);
      const off = cloneConfig();
      off.agents.modelPolicy.fable.enabled = false;
      expect(tiersOf('deep-async', {}, off)).toEqual(['opus']);
    });
  });

  describe('result shape', () => {
    it('returns a Set', () => {
      expect(allowedTiers('architect', {}, realConfig)).toBeInstanceOf(Set);
    });

    it('returns a fresh Set each call — mutating it cannot poison the next', () => {
      const first = allowedTiers('architect', {}, realConfig);
      first.add('haiku');
      first.delete('opus');
      expect([...allowedTiers('architect', {}, realConfig)].sort()).toEqual([
        'fable',
        'opus',
      ]);
    });

    it('iterates in catalog order (cheapest first)', () => {
      const config = cloneConfig();
      config.agents.modelPolicy.low = {
        model: 'sonnet',
        agents: ['architect'],
      };
      const order = listTiers();
      const got = [...allowedTiers('architect', {}, config)];
      const ranks = got.map((t) => order.indexOf(t));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(got).toEqual(['sonnet', 'opus', 'fable']);
    });
  });
});
