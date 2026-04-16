import { describe, expect, it } from 'vitest';
import {
  _camelToKebab,
  _CANONICAL_HOOKS,
  _HARNESS_REGISTRY,
  _translateHookEvent,
  _wrapAsMdc,
  convertAgentDefinition,
  detectHarness,
  mapHooks,
  UniversalHarnessAdapter,
} from '../../lib/adapters/universal-harness.js';

describe('universal-harness', () => {
  describe('detectHarness', () => {
    it('detects claude-code from env signal', () => {
      const result = detectHarness({ env: { CLAUDE_CODE: '1' } });
      expect(result.harness.id).toBe('claude-code');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.signals).toContain('env:CLAUDE_CODE');
    });

    it('detects cursor from file signal', () => {
      const result = detectHarness({
        fileExists: (p) => p === '.cursor/rules',
      });
      expect(result.harness.id).toBe('cursor');
      expect(result.signals).toContain('file:.cursor/rules');
    });

    it('detects codex-cli from env', () => {
      const result = detectHarness({ env: { CODEX_CLI: '1' } });
      expect(result.harness.id).toBe('codex-cli');
    });

    it('returns null harness when no signals match', () => {
      const result = detectHarness({ env: {} });
      expect(result.harness).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.signals).toEqual([]);
    });

    it('prefers env signals (weight 2) over file signals (weight 1)', () => {
      const result = detectHarness({
        env: { CLAUDE_CODE: '1' },
        fileExists: (p) => p === '.cursor/rules' || p === '.cursorrules',
      });
      expect(result.harness.id).toBe('claude-code');
    });
  });

  describe('mapHooks', () => {
    it('maps all canonical hooks for claude-code', () => {
      const mappings = mapHooks('claude-code');
      expect(mappings).toHaveLength(_CANONICAL_HOOKS.length);
      for (const m of mappings) {
        expect(m.sourceEvent).toBe(m.targetEvent); // claude-code is identity
        expect(m.mechanism).toBe('settings-hooks');
      }
    });

    it('maps hooks for cursor with kebab-case prefix', () => {
      const mappings = mapHooks('cursor');
      const preToolUse = mappings.find((m) => m.sourceEvent === 'PreToolUse');
      expect(preToolUse.targetEvent).toBe('cursor:pre-tool-use');
    });

    it('returns empty for unknown harness', () => {
      expect(mapHooks('nonexistent')).toEqual([]);
    });
  });

  describe('convertAgentDefinition', () => {
    const agent = { name: 'my-agent', content: '# My Agent\nDoes things', role: 'Test Agent' };

    it('claude-code: returns markdown in agents/', () => {
      const result = convertAgentDefinition(agent, 'claude-code');
      expect(result.path).toBe('agents/my-agent.md');
      expect(result.format).toBe('markdown');
    });

    it('cursor: wraps in .mdc format', () => {
      const result = convertAgentDefinition(agent, 'cursor');
      expect(result.path).toBe('.cursor/rules/my-agent.mdc');
      expect(result.format).toBe('mdc');
      expect(result.content).toContain('alwaysApply: false');
    });

    it('codex-cli: adds role heading', () => {
      const result = convertAgentDefinition(agent, 'codex-cli');
      expect(result.content).toContain('# Agent: Test Agent');
    });

    it('unknown harness: falls back to markdown', () => {
      const result = convertAgentDefinition(agent, 'nonexistent');
      expect(result.format).toBe('markdown');
    });
  });

  describe('_camelToKebab', () => {
    it('converts CamelCase to kebab-case', () => {
      expect(_camelToKebab('PreToolUse')).toBe('pre-tool-use');
      expect(_camelToKebab('SessionStart')).toBe('session-start');
      expect(_camelToKebab('UserPromptSubmit')).toBe('user-prompt-submit');
    });
  });

  describe('_wrapAsMdc', () => {
    it('wraps content with Cursor frontmatter', () => {
      const result = _wrapAsMdc('test', '# Content');
      expect(result).toContain('description: Artibot agent');
      expect(result).toContain('alwaysApply: false');
      expect(result).toContain('# Content');
    });
  });

  describe('HARNESS_REGISTRY', () => {
    it('has at least 6 registered harnesses', () => {
      expect(_HARNESS_REGISTRY.length).toBeGreaterThanOrEqual(6);
    });

    it('each harness has required fields', () => {
      for (const h of _HARNESS_REGISTRY) {
        expect(h.id).toBeTruthy();
        expect(h.name).toBeTruthy();
        expect(h.hookSystem).toBeTruthy();
        expect(h.instructionFile).toBeTruthy();
        expect(h.envSignals.length).toBeGreaterThan(0);
        expect(h.fileSignals.length).toBeGreaterThan(0);
      }
    });
  });

  describe('UniversalHarnessAdapter', () => {
    const baseOpts = {
      pluginRoot: '/fake/path',
      config: { version: '1.15.0' },
    };

    it('accepts explicit targetHarness', () => {
      const adapter = new UniversalHarnessAdapter({ ...baseOpts, targetHarness: 'cursor' });
      expect(adapter.platformId).toBe('cursor');
      expect(adapter.platformName).toBe('Cursor');
    });

    it('falls back to claude-code when no signals', () => {
      const adapter = new UniversalHarnessAdapter({
        ...baseOpts,
        detectionDeps: { env: {} },
      });
      expect(adapter.platformId).toBe('claude-code');
    });

    it('convertSkill returns path under skillsDir', () => {
      const adapter = new UniversalHarnessAdapter({ ...baseOpts, targetHarness: 'claude-code' });
      const result = adapter.convertSkill({ dirName: 'my-skill', content: '# Skill' });
      expect(result.path).toContain('my-skill/SKILL.md');
    });

    it('generateManifest includes platform and version', () => {
      const adapter = new UniversalHarnessAdapter({ ...baseOpts, targetHarness: 'codex-cli' });
      const manifest = adapter.generateManifest();
      const parsed = JSON.parse(manifest.content);
      expect(parsed.platform).toBe('codex-cli');
      expect(parsed.version).toBe('1.15.0');
    });

    it('validate rejects result with missing fields', () => {
      const adapter = new UniversalHarnessAdapter({ ...baseOpts, targetHarness: 'claude-code' });
      const { valid, errors } = adapter.validate({ platform: '', files: [] });
      expect(valid).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
