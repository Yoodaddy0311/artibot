import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetAgentCache } from '../../lib/core/agent-registry.js';
import {
  isRegistryEnabled,
  pickBestAgent,
  resolveAgent,
  resolveAgentByCapability,
  resolveAgentsByLifecycle,
} from '../../lib/runtime/agent-resolver.js';

/**
 * agent-resolver shim — Phase 2 WS-B.3 additive integration.
 *
 * These tests exercise the real plugin agent layout (28 agents, WS-B.1
 * frontmatter) via the memoized registry. Contracts under test: wrapper
 * semantics, composite filters, feature flag default.
 */

describe('agent-resolver', () => {
  beforeEach(() => {
    _resetAgentCache();
    delete process.env.ARTIBOT_AGENT_REGISTRY;
  });

  afterEach(() => {
    delete process.env.ARTIBOT_AGENT_REGISTRY;
  });

  describe('resolveAgent', () => {
    it('returns backend-developer entry with capabilities', async () => {
      const entry = await resolveAgent('backend-developer');
      expect(entry).not.toBeNull();
      expect(entry.name).toBe('backend-developer');
      expect(Array.isArray(entry.capabilities)).toBe(true);
      expect(entry.capabilities.length).toBeGreaterThan(0);
    });

    it('returns null for a nonexistent agent', async () => {
      const entry = await resolveAgent('nonexistent-agent-xyz');
      expect(entry).toBeNull();
    });

    it('returns null for empty or non-string input', async () => {
      expect(await resolveAgent('')).toBeNull();
      expect(await resolveAgent(/** @type {any} */ (null))).toBeNull();
    });
  });

  describe('resolveAgentsByLifecycle', () => {
    it('returns at least 8 build-phase agents', async () => {
      const list = await resolveAgentsByLifecycle('build');
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(8);
      for (const a of list) expect(a.lifecycle).toBe('build');
    });

    it('returns empty array for empty input', async () => {
      expect(await resolveAgentsByLifecycle('')).toEqual([]);
    });
  });

  describe('resolveAgentByCapability', () => {
    it('finds code-reviewer when searching for code-review capability', async () => {
      const list = await resolveAgentByCapability('code-review');
      expect(list.length).toBeGreaterThanOrEqual(1);
      const names = list.map((a) => a.name);
      expect(names).toContain('code-reviewer');
    });

    it('returns empty array for unknown capability', async () => {
      const list = await resolveAgentByCapability('nonexistent-capability-xyz');
      expect(list).toEqual([]);
    });
  });

  describe('pickBestAgent', () => {
    it('returns a review-lifecycle agent when criteria.lifecycle=review', async () => {
      const picked = await pickBestAgent({ lifecycle: 'review' });
      expect(picked).not.toBeNull();
      expect(picked.lifecycle).toBe('review');
    });

    it('honors preferred name when it matches the filter', async () => {
      const picked = await pickBestAgent({
        lifecycle: 'review',
        preferred: 'security-reviewer',
      });
      expect(picked).not.toBeNull();
      expect(picked.name).toBe('security-reviewer');
    });

    it('falls back to first match when preferred does not exist', async () => {
      const picked = await pickBestAgent({
        lifecycle: 'review',
        preferred: 'nonexistent-reviewer-xyz',
      });
      expect(picked).not.toBeNull();
      expect(picked.lifecycle).toBe('review');
    });

    it('returns backend-developer when capability=database-integration', async () => {
      const picked = await pickBestAgent({ capability: 'database-integration' });
      expect(picked).not.toBeNull();
      expect(picked.name).toBe('backend-developer');
    });

    it('returns null when no candidates match', async () => {
      const picked = await pickBestAgent({ capability: 'nonexistent-capability-xyz' });
      expect(picked).toBeNull();
    });

    it('returns null for invalid criteria', async () => {
      const picked = await pickBestAgent(/** @type {any} */ (null));
      expect(picked).toBeNull();
    });
  });

  describe('isRegistryEnabled', () => {
    it('returns false by default', () => {
      delete process.env.ARTIBOT_AGENT_REGISTRY;
      expect(isRegistryEnabled()).toBe(false);
    });

    it('returns true when ARTIBOT_AGENT_REGISTRY=enabled', () => {
      process.env.ARTIBOT_AGENT_REGISTRY = 'enabled';
      expect(isRegistryEnabled()).toBe(true);
    });

    it('returns false for other env values', () => {
      process.env.ARTIBOT_AGENT_REGISTRY = 'on';
      expect(isRegistryEnabled()).toBe(false);
    });
  });
});
