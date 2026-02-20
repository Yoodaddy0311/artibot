import { describe, it, expect } from 'vitest';
import { configSchema, validateConfig } from '../../lib/core/config-schema.js';

describe('config-schema', () => {
  describe('configSchema', () => {
    it('exports a valid schema object', () => {
      expect(configSchema).toBeDefined();
      expect(configSchema.type).toBe('object');
      expect(configSchema.required).toContain('version');
      expect(configSchema.properties).toBeDefined();
    });

    it('defines expected top-level properties', () => {
      const keys = Object.keys(configSchema.properties);
      expect(keys).toContain('version');
      expect(keys).toContain('agents');
      expect(keys).toContain('team');
      expect(keys).toContain('automation');
      expect(keys).toContain('output');
      expect(keys).toContain('cognitive');
      expect(keys).toContain('learning');
    });
  });

  describe('validateConfig()', () => {
    it('passes a valid minimal config', () => {
      const config = { version: '1.0.0' };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes a full valid config', () => {
      const config = {
        version: '1.4.0',
        agents: {
          modelPolicy: { high: { model: 'opus' } },
          categories: { manager: ['orchestrator'] },
          taskBased: { 'code review': 'code-reviewer' },
        },
        team: {
          enabled: true,
          engine: 'claude-agent-teams',
          maxTeammates: 7,
          ctoAgent: 'orchestrator',
          delegationMode: true,
          displayMode: 'auto',
          spawnStrategy: 'on-demand-parallel',
        },
        automation: {
          intentDetection: true,
          ambiguityThreshold: 50,
          supportedLanguages: ['en', 'ko', 'ja'],
        },
        cognitive: {
          router: { threshold: 0.4, adaptRate: 0.05 },
          system1: { maxLatency: 100, minConfidence: 0.6 },
          system2: { maxRetries: 3, sandboxEnabled: true },
        },
        learning: {
          memoryScopes: { user: '~/.claude/artibot/' },
          lifelong: { batchSize: 50, grpoGroupSize: 5 },
          knowledgeTransfer: { promotionThreshold: 3, demotionThreshold: 2 },
        },
        output: {
          maxContextLength: 500,
          defaultStyle: 'artibot-default',
        },
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects missing required field (version)', () => {
      const config = { team: { enabled: true } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('Missing required field: version')]),
      );
    });

    it('detects wrong type for version (number instead of string)', () => {
      const config = { version: 123 };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('version: expected string, got number')]),
      );
    });

    it('detects version not matching semver pattern', () => {
      const config = { version: 'abc' };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('does not match pattern')]),
      );
    });

    it('detects wrong type for team.enabled (string instead of boolean)', () => {
      const config = { version: '1.0.0', team: { enabled: 'yes' } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('team.enabled')]),
      );
    });

    it('detects team.maxTeammates below minimum', () => {
      const config = { version: '1.0.0', team: { maxTeammates: 0 } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('below minimum')]),
      );
    });

    it('detects team.maxTeammates above maximum', () => {
      const config = { version: '1.0.0', team: { maxTeammates: 100 } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds maximum')]),
      );
    });

    it('allows team.maxTeammates to be null', () => {
      const config = { version: '1.0.0', team: { maxTeammates: null } };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects automation.ambiguityThreshold out of range (above 100)', () => {
      const config = { version: '1.0.0', automation: { ambiguityThreshold: 150 } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds maximum')]),
      );
    });

    it('detects automation.ambiguityThreshold out of range (below 0)', () => {
      const config = { version: '1.0.0', automation: { ambiguityThreshold: -5 } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('below minimum')]),
      );
    });

    it('detects wrong type in supportedLanguages array items', () => {
      const config = { version: '1.0.0', automation: { supportedLanguages: [42, true] } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('expected string')]),
      );
    });

    it('detects wrong type for automation.intentDetection', () => {
      const config = { version: '1.0.0', automation: { intentDetection: 'yes' } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('automation.intentDetection')]),
      );
    });

    it('detects cognitive.router.threshold out of range', () => {
      const config = { version: '1.0.0', cognitive: { router: { threshold: 2.5 } } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds maximum')]),
      );
    });

    it('detects cognitive.system2.maxRetries out of range', () => {
      const config = { version: '1.0.0', cognitive: { system2: { maxRetries: 20 } } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('exceeds maximum')]),
      );
    });

    it('allows extra properties (non-strict mode)', () => {
      const config = {
        version: '1.0.0',
        customField: 'hello',
        anotherExtra: { nested: true },
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects non-object config (null)', () => {
      const result = validateConfig(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('must be a plain object')]),
      );
    });

    it('rejects non-object config (string)', () => {
      const result = validateConfig('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('must be a plain object')]),
      );
    });

    it('rejects non-object config (array)', () => {
      const result = validateConfig([1, 2, 3]);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('must be a plain object')]),
      );
    });

    it('detects output.maxContextLength wrong type', () => {
      const config = { version: '1.0.0', output: { maxContextLength: 'big' } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('output.maxContextLength')]),
      );
    });

    it('detects output.defaultStyle wrong type', () => {
      const config = { version: '1.0.0', output: { defaultStyle: 123 } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('output.defaultStyle')]),
      );
    });

    it('detects learning.lifelong.batchSize below minimum', () => {
      const config = { version: '1.0.0', learning: { lifelong: { batchSize: 0 } } };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('below minimum')]),
      );
    });

    it('validates deeply nested cognitive properties', () => {
      const config = {
        version: '1.0.0',
        cognitive: {
          router: { threshold: 0.4, adaptRate: 0.05 },
          system1: { maxLatency: 100, minConfidence: 0.6 },
          system2: { maxRetries: 3, sandboxEnabled: true },
        },
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('collects multiple errors at once', () => {
      const config = {
        // missing version (required)
        team: { enabled: 'not-boolean', maxTeammates: 999 },
        automation: { ambiguityThreshold: -10 },
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});
