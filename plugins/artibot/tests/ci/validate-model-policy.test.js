/**
 * Tests for the model-policy drift gate (scripts/ci/validate-model-policy.js).
 *
 * Exercises the pure comparison core `findModelPolicyDrift` with in-memory
 * fixtures — no live filesystem dependency for pass/fail assertions, so the
 * drift logic is verified deterministically.
 *
 * @module tests/ci/validate-model-policy
 */

import { describe, expect, it } from 'vitest';
import { findModelPolicyDrift } from '../../scripts/ci/validate-model-policy.js';

/**
 * Build a `resolvePolicyModel` lookup from a plain { name: model } map.
 * Unknown names return null (the strict-lookup contract of getPolicyModel).
 *
 * @param {Record<string, 'opus'|'sonnet'>} map
 * @returns {(name: string) => ('opus'|'sonnet'|null)}
 */
function lookupFrom(map) {
  return (name) => (name in map ? map[name] : null);
}

describe('findModelPolicyDrift', () => {
  it('reports no errors/warnings when frontmatter matches policy exactly', () => {
    const policyMap = { planner: 'opus', 'doc-updater': 'sonnet' };
    const { errors, warnings } = findModelPolicyDrift({
      agentModels: [
        { name: 'planner', model: 'opus' },
        { name: 'doc-updater', model: 'sonnet' },
      ],
      resolvePolicyModel: lookupFrom(policyMap),
      policyAgents: ['planner', 'doc-updater'],
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('flags a frontmatter↔config model mismatch as an ERROR', () => {
    const policyMap = { planner: 'opus' };
    const { errors, warnings } = findModelPolicyDrift({
      agentModels: [{ name: 'planner', model: 'sonnet' }], // wrong model
      resolvePolicyModel: lookupFrom(policyMap),
      policyAgents: ['planner'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/frontmatter↔config mismatch/);
    expect(errors[0]).toContain('planner');
    expect(warnings).toEqual([]);
  });

  it('treats a missing "model:" field on a policy agent as an ERROR', () => {
    const policyMap = { planner: 'opus' };
    const { errors } = findModelPolicyDrift({
      agentModels: [{ name: 'planner', model: null }],
      resolvePolicyModel: lookupFrom(policyMap),
      policyAgents: ['planner'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/no "model:" field/);
  });

  it('flags a policy agent with no file as an ERROR', () => {
    const policyMap = { planner: 'opus', ghost: 'opus' };
    const { errors } = findModelPolicyDrift({
      agentModels: [{ name: 'planner', model: 'opus' }], // ghost.md absent
      resolvePolicyModel: lookupFrom(policyMap),
      policyAgents: ['planner', 'ghost'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/policy agent missing file/);
    expect(errors[0]).toContain('ghost');
  });

  it('flags an unlisted agent file as a WARNING (not an error)', () => {
    const policyMap = { planner: 'opus' };
    const { errors, warnings } = findModelPolicyDrift({
      agentModels: [
        { name: 'planner', model: 'opus' },
        { name: 'experimental', model: 'opus' }, // not in any bucket
      ],
      resolvePolicyModel: lookupFrom(policyMap),
      policyAgents: ['planner'],
    });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/file not in policy/);
    expect(warnings[0]).toContain('experimental');
  });

  it('accumulates multiple drift findings across categories', () => {
    const policyMap = { planner: 'opus', 'doc-updater': 'sonnet', ghost: 'opus' };
    const { errors, warnings } = findModelPolicyDrift({
      agentModels: [
        { name: 'planner', model: 'sonnet' }, // mismatch (ERROR)
        { name: 'doc-updater', model: 'sonnet' }, // ok
        { name: 'rogue', model: 'opus' }, // not in policy (WARN)
      ],
      resolvePolicyModel: lookupFrom(policyMap),
      policyAgents: ['planner', 'doc-updater', 'ghost'], // ghost has no file (ERROR)
    });
    expect(errors).toHaveLength(2); // mismatch + missing-file
    expect(warnings).toHaveLength(1); // rogue
    expect(errors.some((e) => /planner/.test(e) && /mismatch/.test(e))).toBe(true);
    expect(errors.some((e) => /ghost/.test(e) && /missing file/.test(e))).toBe(true);
  });
});
