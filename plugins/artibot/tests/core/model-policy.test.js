import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  getPolicyModel,
  isKnownAgent,
  listAgentsByModel,
  loadModelPolicy,
  normalizeAgentType,
  resolveModel,
  resolveModelForPhase,
} from '../../lib/core/model-policy.js';

// Read the real config so expected counts/agents are derived, not hardcoded.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', '..', 'artibot.config.json');
const realConfig = JSON.parse(await readFile(configPath, 'utf8'));
const policy = realConfig.agents.modelPolicy;
const opusAgents = policy.high.agents;
const sonnetAgents = policy.medium.agents;

describe('model-policy', () => {
  describe('normalizeAgentType()', () => {
    it('strips artibot: prefix', () => {
      expect(normalizeAgentType('artibot:planner')).toBe('planner');
    });

    it('strips artibot-cowork: prefix', () => {
      expect(normalizeAgentType('artibot-cowork:doc-updater')).toBe(
        'doc-updater',
      );
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeAgentType('  orchestrator  ')).toBe('orchestrator');
    });

    it('returns bare name unchanged', () => {
      expect(normalizeAgentType('architect')).toBe('architect');
    });

    it('returns empty string for non-string input', () => {
      expect(normalizeAgentType(42)).toBe('');
      expect(normalizeAgentType(null)).toBe('');
      expect(normalizeAgentType(undefined)).toBe('');
      expect(normalizeAgentType({})).toBe('');
    });
  });

  describe('getPolicyModel()', () => {
    it('returns opus for a known high-bucket agent', () => {
      expect(getPolicyModel('orchestrator', realConfig)).toBe('opus');
      expect(getPolicyModel('planner', realConfig)).toBe('opus');
    });

    it('resolves prefixed names the same as bare names', () => {
      expect(getPolicyModel('artibot:planner', realConfig)).toBe('opus');
      expect(getPolicyModel('artibot:planner', realConfig)).toBe(
        getPolicyModel('planner', realConfig),
      );
    });

    it('returns sonnet for a known medium-bucket agent', () => {
      expect(getPolicyModel('doc-updater', realConfig)).toBe('sonnet');
      expect(getPolicyModel('seo-specialist', realConfig)).toBe('sonnet');
    });

    it('returns null for an unknown agent', () => {
      expect(getPolicyModel('totally-unknown-agent', realConfig)).toBeNull();
    });

    it('returns null for empty/non-string input', () => {
      expect(getPolicyModel('', realConfig)).toBeNull();
      expect(getPolicyModel(null, realConfig)).toBeNull();
    });
  });

  describe('loadModelPolicy()', () => {
    it('normalizes the real config policy shape', () => {
      const p = loadModelPolicy(realConfig);
      expect(p.high.model).toBe('opus');
      expect(p.medium.model).toBe('sonnet');
      expect(p.defaultModel).toBe(DEFAULT_MODEL);
      expect(p.advisorStrategy).toMatchObject({
        enabled: true,
        advisorModel: 'opus',
      });
    });

    it('returns a safe default when policy is missing', () => {
      const p = loadModelPolicy({ agents: {} });
      expect(p.high.agents).toEqual([]);
      expect(p.medium.agents).toEqual([]);
      expect(p.advisorStrategy).toBeNull();
      expect(p.defaultModel).toBe(DEFAULT_MODEL);
    });

    it('returns a safe default for malformed input', () => {
      const p = loadModelPolicy({ agents: { modelPolicy: 'nonsense' } });
      expect(p.high.agents).toEqual([]);
      expect(p.medium.agents).toEqual([]);
    });

    it('does not mutate the source config', () => {
      const snapshot = JSON.stringify(realConfig.agents.modelPolicy);
      loadModelPolicy(realConfig);
      expect(JSON.stringify(realConfig.agents.modelPolicy)).toBe(snapshot);
    });
  });

  describe('resolveModel()', () => {
    it('resolves a bucket agent to its policy model', () => {
      expect(resolveModel('planner', {}, realConfig)).toBe('opus');
      expect(resolveModel('doc-updater', {}, realConfig)).toBe('sonnet');
    });

    it('falls back to DEFAULT_MODEL for unknown agents', () => {
      expect(resolveModel('nobody-here', {}, realConfig)).toBe(DEFAULT_MODEL);
    });

    it('role review/inspect overrides bucket to sonnet', () => {
      expect(resolveModel('planner', { role: 'review' }, realConfig)).toBe(
        'sonnet',
      );
      expect(resolveModel('orchestrator', { role: 'inspect' }, realConfig)).toBe(
        'sonnet',
      );
    });

    it('role implementation/build overrides bucket to opus', () => {
      expect(
        resolveModel('doc-updater', { role: 'implementation' }, realConfig),
      ).toBe('opus');
      expect(resolveModel('seo-specialist', { role: 'build' }, realConfig)).toBe(
        'opus',
      );
    });

    it('unknown role falls through to bucket resolution', () => {
      expect(resolveModel('planner', { role: 'mystery' }, realConfig)).toBe(
        'opus',
      );
    });

    it('advisor:true with advisorStrategy.enabled returns advisorModel', () => {
      expect(resolveModel('doc-updater', { advisor: true }, realConfig)).toBe(
        'opus',
      );
    });

    it('advisor:true ignored when advisorStrategy is disabled', () => {
      const disabled = {
        agents: {
          modelPolicy: {
            ...policy,
            advisorStrategy: { ...policy.advisorStrategy, enabled: false },
          },
        },
      };
      // advisor ignored → falls through to bucket (sonnet for doc-updater)
      expect(resolveModel('doc-updater', { advisor: true }, disabled)).toBe(
        'sonnet',
      );
    });

    it('handles non-object opts safely', () => {
      expect(resolveModel('planner', null, realConfig)).toBe('opus');
    });
  });

  describe('resolveModelForPhase()', () => {
    it('maps build-side roles to opus', () => {
      for (const role of ['implementation', 'build', 'impl']) {
        expect(resolveModelForPhase(role)).toBe('opus');
      }
    });

    it('maps review-side roles to sonnet', () => {
      for (const role of ['review', 'inspect', 'crosscheck']) {
        expect(resolveModelForPhase(role)).toBe('sonnet');
      }
    });

    it('maps unknown role to DEFAULT_MODEL', () => {
      expect(resolveModelForPhase('something-else')).toBe(DEFAULT_MODEL);
    });

    it('maps non-string input to DEFAULT_MODEL', () => {
      expect(resolveModelForPhase(null)).toBe(DEFAULT_MODEL);
      expect(resolveModelForPhase(99)).toBe(DEFAULT_MODEL);
    });
  });

  describe('listAgentsByModel()', () => {
    it('lists all opus agents matching config count', () => {
      const list = listAgentsByModel('opus', realConfig);
      expect(list).toHaveLength(opusAgents.length);
      expect(list).toContain('orchestrator');
      expect(list).toContain('planner');
    });

    it('lists all sonnet agents matching config count', () => {
      const list = listAgentsByModel('sonnet', realConfig);
      expect(list).toHaveLength(sonnetAgents.length);
      expect(list).toContain('doc-updater');
    });

    it('returns a copy, not the original array', () => {
      const list = listAgentsByModel('opus', realConfig);
      list.push('mutant');
      expect(listAgentsByModel('opus', realConfig)).not.toContain('mutant');
    });

    it('returns [] for an unknown model', () => {
      expect(listAgentsByModel('haiku', realConfig)).toEqual([]);
    });

    it('returns [] for non-string input', () => {
      expect(listAgentsByModel(null, realConfig)).toEqual([]);
    });
  });

  describe('isKnownAgent()', () => {
    it('is true for a bucket agent', () => {
      expect(isKnownAgent('planner', realConfig)).toBe(true);
      expect(isKnownAgent('artibot:doc-updater', realConfig)).toBe(true);
    });

    it('is false for an unknown agent', () => {
      expect(isKnownAgent('ghost-agent', realConfig)).toBe(false);
    });
  });

  describe('never-throws (no config loaded, bad input)', () => {
    // No config passed and getConfig() would throw — all must degrade safely.
    it('getPolicyModel returns null without crashing', () => {
      expect(getPolicyModel('planner')).toBeNull();
    });

    it('loadModelPolicy returns empty-ish default', () => {
      const p = loadModelPolicy();
      expect(p.high.agents).toEqual([]);
      expect(p.defaultModel).toBe(DEFAULT_MODEL);
    });

    it('resolveModel returns DEFAULT_MODEL', () => {
      expect(resolveModel('planner')).toBe(DEFAULT_MODEL);
    });

    it('handles null/undefined/number agent input', () => {
      expect(getPolicyModel(null, realConfig)).toBeNull();
      expect(getPolicyModel(undefined, realConfig)).toBeNull();
      expect(getPolicyModel(42, realConfig)).toBeNull();
      expect(resolveModel(null, {}, realConfig)).toBe(DEFAULT_MODEL);
      expect(isKnownAgent(42, realConfig)).toBe(false);
    });
  });
});
