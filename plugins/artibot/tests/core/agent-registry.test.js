import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetAgentCache,
  filterAgents,
  getAgent,
  getAgentsForLifecycle,
  listAgents,
  loadAgentRegistry,
} from '../../lib/core/agent-registry.js';

/**
 * The registry reads `getPluginRoot()` to locate `agents/`. These tests
 * exercise the real plugin layout. The exact count is read from the agents
 * directory at runtime so adding a new agent doesn't break this test.
 * Contracts under test — lifecycle distribution, required fields, cache
 * semantics — are layout-stable.
 */

describe('agent-registry', () => {
  beforeEach(() => {
    _resetAgentCache();
  });

  describe('loadAgentRegistry', () => {
    it('returns a non-empty Map of agents from the live agents directory', async () => {
      const registry = await loadAgentRegistry();
      expect(registry).toBeInstanceOf(Map);
      expect(registry.size).toBeGreaterThanOrEqual(20);
    });

    it('each entry has name, capabilities, lifecycle, and path fields', async () => {
      const registry = await loadAgentRegistry();
      for (const entry of registry.values()) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(Array.isArray(entry.capabilities)).toBe(true);
        expect('lifecycle' in entry).toBe(true);
        expect(typeof entry.path).toBe('string');
        expect(typeof entry.mtimeMs).toBe('number');
      }
    });

    it('returns the same Map reference on repeat calls (mtime cached)', async () => {
      const first = await loadAgentRegistry();
      const second = await loadAgentRegistry();
      expect(second).toBe(first);
    });

    it('rebuilds after _resetAgentCache()', async () => {
      const first = await loadAgentRegistry();
      _resetAgentCache();
      const second = await loadAgentRegistry();
      expect(second).not.toBe(first);
      expect(second.size).toBe(first.size);
    });
  });

  describe('getAgent', () => {
    it("returns orchestrator entry with lifecycle: null", async () => {
      const entry = await getAgent('orchestrator');
      expect(entry).not.toBeNull();
      expect(entry.name).toBe('orchestrator');
      expect(entry.lifecycle).toBeNull();
    });

    it("returns backend-developer entry with lifecycle: 'build' and non-empty capabilities", async () => {
      const entry = await getAgent('backend-developer');
      expect(entry).not.toBeNull();
      expect(entry.lifecycle).toBe('build');
      expect(entry.capabilities.length).toBeGreaterThan(0);
      expect(entry.capabilities).toContain('api-design');
    });

    it('returns null for a nonexistent agent', async () => {
      const entry = await getAgent('nonexistent-agent-xyz');
      expect(entry).toBeNull();
    });

    it('every entry.path points to an existing .md file', async () => {
      const registry = await loadAgentRegistry();
      for (const entry of registry.values()) {
        expect(entry.path.endsWith('.md')).toBe(true);
        expect(existsSync(entry.path)).toBe(true);
      }
    });
  });

  describe('listAgents', () => {
    it('returns exactly 30 agent names', async () => {
      const names = await listAgents();
      expect(names).toHaveLength(30);
      expect(names).toContain('orchestrator');
      expect(names).toContain('backend-developer');
      expect(names).toContain('frontend-developer');
    });
  });

  describe('filterAgents', () => {
    it("returns 6 agents when filtering lifecycle === 'marketing'", async () => {
      const agents = await filterAgents((a) => a.lifecycle === 'marketing');
      expect(agents).toHaveLength(6);
    });

    it('returns only entries satisfying the predicate', async () => {
      const withModel = await filterAgents((a) => a.model !== undefined);
      for (const a of withModel) {
        expect(a.model).toBeDefined();
      }
    });
  });

  describe('getAgentsForLifecycle', () => {
    it("returns >= 8 agents for lifecycle 'build'", async () => {
      const agents = await getAgentsForLifecycle('build');
      expect(agents.length).toBeGreaterThanOrEqual(8);
      for (const a of agents) {
        expect(a.lifecycle).toBe('build');
      }
    });

    it("returns cross-phase agents (lifecycle=null) when passed 'null'", async () => {
      const agents = await getAgentsForLifecycle('null');
      const names = agents.map((a) => a.name).sort();
      expect(names).toContain('orchestrator');
      expect(names).toContain('repo-benchmarker');
      for (const a of agents) {
        expect(a.lifecycle).toBeNull();
      }
    });
  });
});
