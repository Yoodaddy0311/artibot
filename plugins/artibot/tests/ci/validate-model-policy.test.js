/**
 * Tests for the model-policy drift gate (scripts/ci/validate-model-policy.js).
 *
 * Exercises the pure comparison core `findModelPolicyDrift` with in-memory
 * fixtures — no live filesystem dependency for pass/fail assertions, so the
 * drift logic is verified deterministically.
 *
 * @module tests/ci/validate-model-policy
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectPolicyAgents,
  findModelPolicyDrift,
  readAgentModels,
} from '../../scripts/ci/validate-model-policy.js';
import { getPolicyModel, resolveModel } from '../../lib/core/model-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const realConfig = JSON.parse(
  await readFile(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf8'),
);

/** The gate-aware lookup the CLI uses (mirrors validate-model-policy.js#main). */
const gateAwareLookup = (config) => (name) =>
  getPolicyModel(name, config) === null ? null : resolveModel(name, {}, config);

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

describe('gate-aware drift check against the shipped repo (single-tier opus, owner 2026-09-23)', () => {
  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  const agentModels = readAgentModels(agentsDir);
  const policyAgents = collectPolicyAgents(realConfig);
  const allowlist = realConfig.agents.modelPolicy.fable.allowlist;
  /** The shipped config with ONLY the kill-switch flipped back on. */
  const gateOn = () => {
    const config = structuredClone(realConfig);
    config.agents.modelPolicy.fable.enabled = true;
    return config;
  };

  it('the live agents/ tree has zero drift against the live config', () => {
    const { errors, warnings } = findModelPolicyDrift({
      agentModels,
      resolvePolicyModel: gateAwareLookup(realConfig),
      policyAgents,
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('no agent file declares model: fable while the kill-switch is off', () => {
    expect(realConfig.agents.modelPolicy.fable.enabled).toBe(false);
    const fableFiles = agentModels.filter((a) => a.model === 'fable').map((a) => a.name);
    expect(fableFiles).toEqual([]);
    // Every policy agent's file says opus — the single-tier fleet, counted.
    const opusFiles = agentModels.filter((a) => a.model === 'opus').map((a) => a.name).sort();
    expect(opusFiles).toEqual([...policyAgents].sort());
  });

  it('the dormant allowlist still names 10 agents that each have a file', () => {
    expect(allowlist).toHaveLength(10);
    const fileNames = new Set(agentModels.map((a) => a.name));
    expect(allowlist.filter((name) => !fileNames.has(name))).toEqual([]);
  });

  it('a dormant-allowlisted agent left on model: fable IS drift (negative control for the revert)', () => {
    // One frontmatter line missed during the revert must turn the gate RED.
    const { errors } = findModelPolicyDrift({
      agentModels: [{ name: 'code-reviewer', model: 'fable' }],
      resolvePolicyModel: gateAwareLookup(realConfig),
      policyAgents: ['code-reviewer'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/code-reviewer/);
    expect(errors[0]).toMatch(/model "fable" ≠ policy "opus"/);
  });

  it('a non-allowlisted high-bucket agent with model: opus is NOT drift (allowlist wins over bucket, gate on)', () => {
    // backend-developer: high bucket declares fable, gate demotes to opus, file says opus.
    const { errors } = findModelPolicyDrift({
      agentModels: [{ name: 'backend-developer', model: 'opus' }],
      resolvePolicyModel: gateAwareLookup(gateOn()),
      policyAgents: ['backend-developer'],
    });
    expect(errors).toEqual([]);
  });

  it('a non-allowlisted high-bucket agent with model: fable IS drift (gate on)', () => {
    const { errors } = findModelPolicyDrift({
      agentModels: [{ name: 'backend-developer', model: 'fable' }],
      resolvePolicyModel: gateAwareLookup(gateOn()),
      policyAgents: ['backend-developer'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/model "fable" ≠ policy "opus"/);
  });

  it('flipping the kill-switch back ON without re-syncing the 10 frontmatter lines is caught as drift', () => {
    const { errors } = findModelPolicyDrift({
      agentModels,
      resolvePolicyModel: gateAwareLookup(gateOn()),
      policyAgents,
    });
    expect(errors).toHaveLength(allowlist.length);
    for (const e of errors) expect(e).toMatch(/model "opus" ≠ policy "fable"/);
    for (const name of allowlist) {
      expect(errors.some((e) => e.includes(`agents/${name}.md`))).toBe(true);
    }
  });
});
