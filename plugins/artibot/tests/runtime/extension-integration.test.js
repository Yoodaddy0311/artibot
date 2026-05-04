import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionRegistry } from '../../lib/core/extension.js';
import { _resetSkillCaches, createSkillsMiddleware } from '../../lib/runtime/middleware/skills.js';

function makeState(overrides = {}) {
  return {
    context: {
      intent: {
        best: 'action:implement',
        commands: ['/implement'],
        agents: ['frontend-developer'],
        intents: ['action:implement'],
        ambiguous: false,
      },
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'test',
    config: {},
    ...overrides,
  };
}

describe('extension-integration', () => {
  let registry;

  beforeEach(() => {
    registry = createExtensionRegistry();
    _resetSkillCaches();
  });

  // ---------------------------------------------------------------------------
  describe('skills middleware + extension registry', () => {
    it('includes extension skill in suggested when name matches intent keyword', async () => {
      registry.registerSkill('implement-helper', {
        name: 'implement-helper',
        description: 'Helps with implementation',
        triggers: ['implement'],
      });

      const mw = createSkillsMiddleware({ extensionRegistry: registry });
      const state = makeState();
      await mw(state);

      expect(state.context.skills.suggested).toContain('implement-helper');
      expect(state.context.skills.extensionSkills).toContain('implement-helper');
    });

    it('includes extension skill in suggested when trigger matches', async () => {
      registry.registerSkill('deploy-tool', {
        name: 'deploy-tool',
        description: 'Deployment automation',
        triggers: ['action:implement'],
      });

      const mw = createSkillsMiddleware({ extensionRegistry: registry });
      const state = makeState();
      await mw(state);

      expect(state.context.skills.suggested).toContain('deploy-tool');
      expect(state.context.skills.extensionSkills).toContain('deploy-tool');
    });

    it('does not include extension skill when no keyword match', async () => {
      registry.registerSkill('unrelated-skill', {
        name: 'unrelated-skill',
        description: 'Nothing to do with implement',
        triggers: ['deploy', 'release'],
      });

      const mw = createSkillsMiddleware({ extensionRegistry: registry });
      const state = makeState();
      await mw(state);

      expect(state.context.skills.suggested).not.toContain('unrelated-skill');
      expect(state.context.skills.extensionSkills).toBeUndefined();
    });

    it('deduplicates extension skills already in suggested', async () => {
      registry.registerSkill('cmd-implement', {
        name: 'cmd-implement',
        description: 'Duplicate of built-in',
        triggers: ['implement'],
      });

      const mw = createSkillsMiddleware({ extensionRegistry: registry });
      const state = makeState();
      await mw(state);

      const count = state.context.skills.suggested.filter((s) => s === 'cmd-implement').length;
      expect(count).toBe(1);
    });

    it('works without extension registry (null)', async () => {
      const mw = createSkillsMiddleware({ extensionRegistry: null });
      const state = makeState();
      await mw(state);

      expect(state.context.skills.suggested).toContain('cmd-implement');
      expect(state.context.skills.extensionSkills).toBeUndefined();
    });

    it('works without extension registry (omitted)', async () => {
      const mw = createSkillsMiddleware();
      const state = makeState();
      await mw(state);

      expect(state.context.skills.suggested).toContain('cmd-implement');
      expect(state.context.skills.extensionSkills).toBeUndefined();
    });

    it('handles extension skill without triggers array', async () => {
      registry.registerSkill('implement-basic', {
        name: 'implement-basic',
        description: 'Has implement in name but no triggers',
      });

      const mw = createSkillsMiddleware({ extensionRegistry: registry });
      const state = makeState();
      await mw(state);

      // Should match on name containing 'implement'
      expect(state.context.skills.suggested).toContain('implement-basic');
    });

    it('multiple extension skills can match simultaneously', async () => {
      registry.registerSkill('implement-a', {
        name: 'implement-a',
        description: 'Extension A',
        triggers: ['implement'],
      });
      registry.registerSkill('implement-b', {
        name: 'implement-b',
        description: 'Extension B',
        triggers: ['action:implement'],
      });

      const mw = createSkillsMiddleware({ extensionRegistry: registry });
      const state = makeState();
      await mw(state);

      expect(state.context.skills.extensionSkills).toContain('implement-a');
      expect(state.context.skills.extensionSkills).toContain('implement-b');
      expect(state.context.skills.extensionSkills).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  describe('createArtibotAgent extension registry', () => {
    it('agent exposes extensions property with registry API', async () => {
      // Dynamic import to avoid loading all middleware deps at module scope
      const { createArtibotAgent } = await import('../../lib/runtime/create-artibot-agent.js');

      const agent = createArtibotAgent({
        config: {
          automation: { supportedLanguages: ['en'], ambiguityThreshold: 50 },
          team: { enabled: false },
          cognitive: { router: { threshold: 0.4 } },
        },
        now: () => 1000,
      });

      expect(agent.extensions).toBeDefined();
      expect(typeof agent.extensions.registerSkill).toBe('function');
      expect(typeof agent.extensions.registerHook).toBe('function');
      expect(typeof agent.extensions.listExtensions).toBe('function');
      expect(typeof agent.extensions.getSkill).toBe('function');
      expect(typeof agent.extensions.getHooksForEvent).toBe('function');
      expect(typeof agent.extensions.unregisterSkill).toBe('function');
      expect(typeof agent.extensions.unregisterHook).toBe('function');
      expect(typeof agent.extensions.reset).toBe('function');
    });

    it('accepts pre-created extension registry via options', async () => {
      const { createArtibotAgent } = await import('../../lib/runtime/create-artibot-agent.js');
      const customRegistry = createExtensionRegistry();
      customRegistry.registerSkill('pre-loaded', {
        name: 'pre-loaded',
        description: 'Pre-loaded skill',
      });

      const agent = createArtibotAgent({
        config: {
          automation: { supportedLanguages: ['en'], ambiguityThreshold: 50 },
          team: { enabled: false },
          cognitive: { router: { threshold: 0.4 } },
        },
        extensionRegistry: customRegistry,
        now: () => 1000,
      });

      expect(agent.extensions).toBe(customRegistry);
      expect(agent.extensions.getSkill('pre-loaded')).toBeDefined();
    });

    it('extension hooks are called during preparePrompt', async () => {
      const { createArtibotAgent } = await import('../../lib/runtime/create-artibot-agent.js');
      const customRegistry = createExtensionRegistry();

      const preCommandSpy = vi.fn();
      const postExecuteSpy = vi.fn();
      customRegistry.registerHook('pre-command', preCommandSpy);
      customRegistry.registerHook('post-execute', postExecuteSpy);

      const agent = createArtibotAgent({
        config: {
          automation: { supportedLanguages: ['en'], ambiguityThreshold: 50 },
          team: { enabled: false },
          cognitive: { router: { threshold: 0.4 } },
        },
        extensionRegistry: customRegistry,
        now: () => 1000,
      });

      await agent.preparePrompt({ prompt: 'test prompt' });

      expect(preCommandSpy).toHaveBeenCalledTimes(1);
      expect(postExecuteSpy).toHaveBeenCalledTimes(1);

      // Verify handlers received the state object
      const preState = preCommandSpy.mock.calls[0][0];
      expect(preState).toHaveProperty('userPrompt');
      expect(preState).toHaveProperty('context');
      expect(preState).toHaveProperty('messageParts');
    });

    it('extension hook errors do not break the pipeline', async () => {
      const { createArtibotAgent } = await import('../../lib/runtime/create-artibot-agent.js');
      const customRegistry = createExtensionRegistry();

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      customRegistry.registerHook('pre-command', () => {
        throw new Error('Hook explosion');
      });

      const agent = createArtibotAgent({
        config: {
          automation: { supportedLanguages: ['en'], ambiguityThreshold: 50 },
          team: { enabled: false },
          cognitive: { router: { threshold: 0.4 } },
        },
        extensionRegistry: customRegistry,
        now: () => 1000,
      });

      const result = await agent.preparePrompt({ prompt: 'test prompt' });

      // Pipeline should complete despite hook error (prompt may be enriched by other middleware)
      expect(result.userPrompt).toContain('test prompt');
      expect(result.message).toContain('ext-hook:pre-command=error');

      stderrSpy.mockRestore();
    });

    it('no extension hooks registered does not affect pipeline', async () => {
      const { createArtibotAgent } = await import('../../lib/runtime/create-artibot-agent.js');

      const agent = createArtibotAgent({
        config: {
          automation: { supportedLanguages: ['en'], ambiguityThreshold: 50 },
          team: { enabled: false },
          cognitive: { router: { threshold: 0.4 } },
        },
        now: () => 1000,
      });

      const result = await agent.preparePrompt({ prompt: 'hello' });

      // Should work normally with empty extension registry
      expect(result.userPrompt).toBeDefined();
      expect(result.context).toBeDefined();
      expect(agent.extensions.listExtensions().hooks).toEqual([]);
    });
  });
});
