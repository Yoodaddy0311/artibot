import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createExtensionRegistry,
  defaultRegistry,
} from '../../lib/core/extension.js';

describe('extension', () => {
  let reg;

  beforeEach(() => {
    reg = createExtensionRegistry();
    defaultRegistry.reset();
  });

  // ---------------------------------------------------------------------------
  describe('registerSkill()', () => {
    const validConfig = { name: 'my-skill', description: 'A test skill' };

    it('registers a skill and returns the entry', () => {
      const result = reg.registerSkill('my-skill', validConfig);
      expect(result.name).toBe('my-skill');
      expect(result.config.description).toBe('A test skill');
      expect(result.registeredAt).toBeDefined();
    });

    it('throws when name is empty', () => {
      expect(() => reg.registerSkill('', validConfig)).toThrow('non-empty string');
    });

    it('throws when name is not a string', () => {
      expect(() => reg.registerSkill(123, validConfig)).toThrow('non-empty string');
    });

    it('throws when name is null', () => {
      expect(() => reg.registerSkill(null, validConfig)).toThrow('non-empty string');
    });

    it('throws when config is null', () => {
      expect(() => reg.registerSkill('s', null)).toThrow('must be an object');
    });

    it('throws when config is not an object', () => {
      expect(() => reg.registerSkill('s', 'bad')).toThrow('must be an object');
    });

    it('throws when config.name is missing', () => {
      expect(() => reg.registerSkill('s', { description: 'x' })).toThrow('missing required field: "name"');
    });

    it('throws when config.description is missing', () => {
      expect(() => reg.registerSkill('s', { name: 's' })).toThrow('missing required field: "description"');
    });

    it('throws when config.name does not match the name parameter', () => {
      expect(() => reg.registerSkill('a', { name: 'b', description: 'x' })).toThrow('must match');
    });

    it('throws when registering a duplicate skill', () => {
      reg.registerSkill('my-skill', validConfig);
      expect(() => reg.registerSkill('my-skill', validConfig)).toThrow('already registered');
    });

    it('returns a copy (no mutation of internal state)', () => {
      const result = reg.registerSkill('my-skill', validConfig);
      result.config.description = 'MUTATED';
      const retrieved = reg.getSkill('my-skill');
      expect(retrieved.config.description).toBe('A test skill');
    });
  });

  // ---------------------------------------------------------------------------
  describe('registerHook()', () => {
    const handler = vi.fn();

    it('registers a hook and returns entry with id', () => {
      const result = reg.registerHook('pre-command', handler);
      expect(result.id).toMatch(/^hook-\d+$/);
      expect(result.event).toBe('pre-command');
      expect(result.registeredAt).toBeDefined();
    });

    it('does not expose the handler function in the return value', () => {
      const result = reg.registerHook('pre-command', handler);
      expect(result.handler).toBeUndefined();
    });

    it('throws when event is empty', () => {
      expect(() => reg.registerHook('', handler)).toThrow('non-empty string');
    });

    it('throws when event is not a string', () => {
      expect(() => reg.registerHook(42, handler)).toThrow('non-empty string');
    });

    it('throws when event is null', () => {
      expect(() => reg.registerHook(null, handler)).toThrow('non-empty string');
    });

    it('throws when handler is not a function', () => {
      expect(() => reg.registerHook('pre-command', 'not a fn')).toThrow('must be a function');
    });

    it('generates unique ids for each hook', () => {
      const a = reg.registerHook('pre-command', handler);
      const b = reg.registerHook('pre-command', handler);
      expect(a.id).not.toBe(b.id);
    });
  });

  // ---------------------------------------------------------------------------
  describe('listExtensions()', () => {
    it('returns empty lists initially', () => {
      const result = reg.listExtensions();
      expect(result.skills).toEqual([]);
      expect(result.hooks).toEqual([]);
    });

    it('lists registered skills', () => {
      reg.registerSkill('s1', { name: 's1', description: 'd1' });
      reg.registerSkill('s2', { name: 's2', description: 'd2' });
      const result = reg.listExtensions();
      expect(result.skills).toHaveLength(2);
      expect(result.skills[0].name).toBe('s1');
      expect(result.skills[1].name).toBe('s2');
    });

    it('lists registered hooks without handler', () => {
      reg.registerHook('evt-a', vi.fn());
      reg.registerHook('evt-b', vi.fn());
      const result = reg.listExtensions();
      expect(result.hooks).toHaveLength(2);
      expect(result.hooks[0].event).toBe('evt-a');
      expect(result.hooks[1].event).toBe('evt-b');
      expect(result.hooks[0].handler).toBeUndefined();
    });

    it('returns copies (no mutation of internal state)', () => {
      reg.registerSkill('s1', { name: 's1', description: 'desc' });
      const list = reg.listExtensions();
      list.skills.push({ name: 'fake' });
      expect(reg.listExtensions().skills).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getSkill()', () => {
    it('returns undefined for unregistered skill', () => {
      expect(reg.getSkill('nonexistent')).toBeUndefined();
    });

    it('returns the skill entry by name', () => {
      reg.registerSkill('s1', { name: 's1', description: 'desc' });
      const result = reg.getSkill('s1');
      expect(result.name).toBe('s1');
      expect(result.config.description).toBe('desc');
    });

    it('returns a copy (no mutation)', () => {
      reg.registerSkill('s1', { name: 's1', description: 'desc' });
      const a = reg.getSkill('s1');
      a.config.description = 'MUTATED';
      expect(reg.getSkill('s1').config.description).toBe('desc');
    });
  });

  // ---------------------------------------------------------------------------
  describe('getHooksForEvent()', () => {
    it('returns empty array for unregistered event', () => {
      expect(reg.getHooksForEvent('nope')).toEqual([]);
    });

    it('returns handler functions for a given event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      reg.registerHook('evt', h1);
      reg.registerHook('evt', h2);
      reg.registerHook('other', vi.fn());
      const handlers = reg.getHooksForEvent('evt');
      expect(handlers).toHaveLength(2);
      expect(handlers[0]).toBe(h1);
      expect(handlers[1]).toBe(h2);
    });
  });

  // ---------------------------------------------------------------------------
  describe('unregisterSkill()', () => {
    it('returns true when skill is found and removed', () => {
      reg.registerSkill('s1', { name: 's1', description: 'd' });
      expect(reg.unregisterSkill('s1')).toBe(true);
      expect(reg.getSkill('s1')).toBeUndefined();
    });

    it('returns false when skill does not exist', () => {
      expect(reg.unregisterSkill('nonexistent')).toBe(false);
    });

    it('allows re-registering after unregister', () => {
      reg.registerSkill('s1', { name: 's1', description: 'd' });
      reg.unregisterSkill('s1');
      expect(() => reg.registerSkill('s1', { name: 's1', description: 'd2' })).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  describe('unregisterHook()', () => {
    it('returns true when hook is found and removed', () => {
      const { id } = reg.registerHook('evt', vi.fn());
      expect(reg.unregisterHook(id)).toBe(true);
      expect(reg.getHooksForEvent('evt')).toHaveLength(0);
    });

    it('returns false when hook id does not exist', () => {
      expect(reg.unregisterHook('hook-999')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('reset()', () => {
    it('clears all skills', () => {
      reg.registerSkill('s1', { name: 's1', description: 'd' });
      reg.reset();
      expect(reg.listExtensions().skills).toEqual([]);
    });

    it('clears all hooks', () => {
      reg.registerHook('evt', vi.fn());
      reg.reset();
      expect(reg.listExtensions().hooks).toEqual([]);
    });

    it('resets hook id counter', () => {
      reg.registerHook('evt', vi.fn());
      reg.reset();
      const { id } = reg.registerHook('evt', vi.fn());
      expect(id).toBe('hook-1');
    });
  });

  // ---------------------------------------------------------------------------
  describe('defaultRegistry', () => {
    it('is a pre-created registry instance', () => {
      expect(typeof defaultRegistry.registerSkill).toBe('function');
      expect(typeof defaultRegistry.registerHook).toBe('function');
      expect(typeof defaultRegistry.listExtensions).toBe('function');
      expect(typeof defaultRegistry.getSkill).toBe('function');
      expect(typeof defaultRegistry.getHooksForEvent).toBe('function');
      expect(typeof defaultRegistry.unregisterSkill).toBe('function');
      expect(typeof defaultRegistry.unregisterHook).toBe('function');
      expect(typeof defaultRegistry.reset).toBe('function');
    });

    it('works independently from createExtensionRegistry instances', () => {
      defaultRegistry.registerSkill('global-skill', { name: 'global-skill', description: 'global' });
      expect(reg.getSkill('global-skill')).toBeUndefined();
      expect(defaultRegistry.getSkill('global-skill')).toBeDefined();
    });
  });
});
