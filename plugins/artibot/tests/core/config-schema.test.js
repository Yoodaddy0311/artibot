import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, validateConfig } from '../../lib/core/config-schema.js';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

  // -------------------------------------------------------------------------
  // `team` declaration coverage
  // -------------------------------------------------------------------------

  describe('team.properties declaration coverage', () => {
    // WHY THIS EXISTS. `validateConfig` is non-strict: an undeclared key is not
    // an error, it is simply unvalidated. So an incomplete `properties` block
    // fails OPEN — `team.followWorkflowPlan: "false"` (a string, which the
    // readers treat as truthy and therefore as ON) sailed through as valid.
    // Measured 2026-09-17 before this change: the schema declared 7 of the 21
    // keys the shipped `artibot.config.json#team` actually carries.
    //
    // WHAT THIS CHECK DOES NOT SEE.
    //  1. Value MEANING. It compares key sets and JSON types only. A declared
    //     `{ type: 'object' }` says nothing about the object's inner keys, so
    //     `autoApplyTriggers.minSubtasks: "four"` is still unvalidated. That is
    //     deliberate: the thresholds' owner is `workflow-plan.js#evaluateTrigger`,
    //     and duplicating their shape here would create a second owner.
    //  2. Whether the declared TYPE is the RIGHT type. Declaring `engine` as
    //     `number` would pass this check and break the real config instead.
    //  3. Keys some other config file or a user override adds. The comparison
    //     is against this repo's shipped `artibot.config.json` only.
    const shippedTeam = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, 'artibot.config.json'), 'utf8'),
    ).team;

    it('declares every key the shipped artibot.config.json#team carries', () => {
      const declared = Object.keys(configSchema.properties.team.properties);
      const shipped = Object.keys(shippedTeam);
      // Superset, not equality: declaring a key the config does not yet use is
      // harmless (`validateProperty` skips `undefined`), while the reverse is
      // the fail-open hole. The direction is the whole point.
      expect(shipped.filter((k) => !declared.includes(k))).toEqual([]);
    });

    it('has a non-trivial denominator (guards a scan that finds nothing)', () => {
      // Without this, an `artibot.config.json` that lost its `team` block would
      // make the check above pass by comparing two empty sets.
      expect(Object.keys(shippedTeam).length).toBeGreaterThanOrEqual(20);
    });

    it('keeps the shipped config valid', () => {
      // The control for the declaration above: adding types must not invalidate
      // the very config those types were read off.
      const shipped = JSON.parse(
        readFileSync(join(PLUGIN_ROOT, 'artibot.config.json'), 'utf8'),
      );
      const result = validateConfig(shipped);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('now rejects a STRING "false" where a boolean opt-out belongs', () => {
      // The effect of the declaration, demonstrated rather than asserted. This
      // config was VALID before `followWorkflowPlan`/`autoApply` were declared.
      // It matters because `isTeamEnabled` gates on `!== false`, so the string
      // "false" reads as ON — the schema is where that typo gets caught.
      for (const key of ['followWorkflowPlan', 'autoApply', 'enabled']) {
        const result = validateConfig({ version: '1.0.0', team: { [key]: 'false' } });
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toContain(`team.${key}: expected boolean, got string`);
      }
    });

    it('accepts the null maxTeammates the shipped config uses', () => {
      // Regression guard for the one key whose shipped value is `null`: a naive
      // `{ type: 'number' }` would reject the repo's own config.
      expect(shippedTeam.maxTeammates).toBeNull();
      const result = validateConfig({ version: '1.0.0', team: { maxTeammates: null } });
      expect(result.valid).toBe(true);
    });
  });
});
