import { describe, expect, it } from 'vitest';
import {
  _VALID_HOOK_EVENTS,
  _VALID_MODELS,
  _validateKebabCase,
  _validateRequired,
  createAgent,
  createHook,
  createMiddleware,
  createSkill,
  validatePackage,
} from '../../lib/sdk/artibot-sdk.js';

describe('artibot-sdk', () => {
  describe('_validateKebabCase', () => {
    it('accepts valid kebab-case', () => {
      expect(_validateKebabCase('my-skill').valid).toBe(true);
      expect(_validateKebabCase('a').valid).toBe(true);
      expect(_validateKebabCase('multi-word-name').valid).toBe(true);
    });

    it('rejects non-kebab-case', () => {
      expect(_validateKebabCase('MySkill').valid).toBe(false);
      expect(_validateKebabCase('my_skill').valid).toBe(false);
      expect(_validateKebabCase('-leading').valid).toBe(false);
      expect(_validateKebabCase('').valid).toBe(false);
    });
  });

  describe('_validateRequired', () => {
    it('passes when all fields present', () => {
      const result = _validateRequired({ a: 'x', b: 'y' }, ['a', 'b']);
      expect(result.valid).toBe(true);
    });

    it('fails for missing fields', () => {
      const result = _validateRequired({ a: 'x' }, ['a', 'b']);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('b');
    });
  });

  describe('createSkill', () => {
    const validSpec = {
      name: 'my-skill',
      description: 'A test skill',
      category: 'engineering',
      body: '# My Skill\n\nDoes things.',
      triggers: ['test', 'demo'],
      agents: ['architect'],
      tokens: '~1K',
      platforms: ['claude-code', 'cursor'],
      level: 2,
    };

    it('generates valid SKILL.md with frontmatter', () => {
      const result = createSkill(validSpec);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.dirName).toBe('my-skill');
      expect(result.skillMd).toContain('name: my-skill');
      expect(result.skillMd).toContain('description: A test skill');
      expect(result.skillMd).toContain('# My Skill');
      expect(result.skillMd).toContain('"test"');
    });

    it('rejects invalid name', () => {
      const result = createSkill({ ...validSpec, name: 'BadName' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('kebab-case');
    });

    it('rejects missing body', () => {
      const result = createSkill({ ...validSpec, body: '' });
      expect(result.valid).toBe(false);
    });

    it('rejects missing required fields', () => {
      const result = createSkill({ name: 'ok', body: 'x' });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('createAgent', () => {
    const validSpec = {
      name: 'test-agent',
      role: 'Test Agent',
      model: 'opus',
      body: '## Instructions\nDo testing.',
      tools: ['Read', 'Grep'],
      skills: ['tdd-workflow'],
      systemPrompt: 'You are a test agent.',
    };

    it('generates valid agent .md', () => {
      const result = createAgent(validSpec);
      expect(result.valid).toBe(true);
      expect(result.fileName).toBe('test-agent.md');
      expect(result.agentMd).toContain('# Test Agent');
      expect(result.agentMd).toContain('**Model**: opus');
      expect(result.agentMd).toContain('Read, Grep');
      expect(result.agentMd).toContain('## System Prompt');
    });

    it('rejects invalid model', () => {
      const result = createAgent({ ...validSpec, model: 'gpt-4' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid model');
    });

    it('rejects missing body', () => {
      const result = createAgent({ ...validSpec, body: null });
      expect(result.valid).toBe(false);
    });
  });

  describe('createHook', () => {
    const validSpec = {
      event: 'PreToolUse',
      name: 'my-hook',
      description: 'Blocks dangerous tools',
      script: 'const data = JSON.parse(await readStdin());',
    };

    it('generates script content and registration', () => {
      const result = createHook(validSpec);
      expect(result.valid).toBe(true);
      expect(result.scriptContent).toContain('#!/usr/bin/env node');
      expect(result.scriptContent).toContain('my-hook');
      expect(result.registration.event).toBe('PreToolUse');
      expect(result.registration.script).toBe('scripts/hooks/my-hook.js');
    });

    it('rejects invalid event', () => {
      const result = createHook({ ...validSpec, event: 'InvalidEvent' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid event');
    });

    it('rejects missing script', () => {
      const result = createHook({ ...validSpec, script: '' });
      expect(result.valid).toBe(false);
    });
  });

  describe('createMiddleware', () => {
    const validSpec = {
      name: 'my-middleware',
      position: 'after',
      target: 'guardrail',
      factoryCode: 'export function createMyMiddleware() { return async (s) => s; }',
    };

    it('generates module content and registration', () => {
      const result = createMiddleware(validSpec);
      expect(result.valid).toBe(true);
      expect(result.moduleContent).toContain('Custom middleware: my-middleware');
      expect(result.registration.name).toBe('my-middleware');
      expect(result.registration.position).toBe('after');
      expect(result.registration.target).toBe('guardrail');
    });

    it('defaults position to after', () => {
      const result = createMiddleware({ ...validSpec, position: undefined });
      expect(result.valid).toBe(true);
      expect(result.registration.position).toBe('after');
    });

    it('rejects invalid position', () => {
      const result = createMiddleware({ ...validSpec, position: 'middle' });
      expect(result.valid).toBe(false);
    });
  });

  describe('validatePackage', () => {
    it('validates a full package with mixed validity', () => {
      const result = validatePackage({
        skills: [
          { name: 'ok-skill', description: 'Valid', category: 'eng', body: '# OK' },
          { name: 'BAD', description: '', category: '', body: '' },
        ],
        agents: [
          { name: 'ok-agent', role: 'Agent', model: 'opus', body: '# A' },
        ],
        hooks: [],
        middleware: [],
      });

      expect(result.valid).toBe(false);
      expect(result.errorCount).toBeGreaterThan(0);
      expect(result.results).toHaveLength(3);
      expect(result.results[0].valid).toBe(true);
      expect(result.results[1].valid).toBe(false);
    });

    it('returns valid for empty package', () => {
      const result = validatePackage({});
      expect(result.valid).toBe(true);
      expect(result.errorCount).toBe(0);
    });
  });

  describe('constants', () => {
    it('VALID_MODELS has expected models', () => {
      expect(_VALID_MODELS.has('opus')).toBe(true);
      expect(_VALID_MODELS.has('sonnet')).toBe(true);
      expect(_VALID_MODELS.has('haiku')).toBe(true);
    });

    it('VALID_HOOK_EVENTS has core events', () => {
      expect(_VALID_HOOK_EVENTS.has('PreToolUse')).toBe(true);
      expect(_VALID_HOOK_EVENTS.has('SessionStart')).toBe(true);
    });
  });
});
