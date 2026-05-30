/**
 * wire-bridges.test.js — covers lib/mcp/bridge/index.js#wireBridges and the
 * end-to-end "tools/list is non-empty after wiring" contract that the path
 * bug (bridges/ vs bridge/) silently broke.
 *
 * Before the fix: bin imported the non-existent `lib/mcp/bridges/index.js`,
 * the import threw, was swallowed, and the server booted with an empty
 * registry. These tests lock in that wireBridges:
 *   - loads as a module and exports wireBridges + the 4 factories,
 *   - registers the 5 built-in tools plus bridge-backed tools,
 *   - makes server.dispatch('tools/list') return a non-empty catalog,
 *   - is idempotent and side-effect-free at wire time (no I/O until called).
 */

import { describe, expect, it } from 'vitest';
import {
  createAgentsBridge,
  createGitBridge,
  createMemoryBridge,
  createSkillsBridge,
  wireBridges,
} from '../../lib/mcp/bridge/index.js';
import { createArtibotMcpServer } from '../../lib/mcp/server.js';
import { builtinTools } from '../../lib/mcp/tools/index.js';

describe('lib/mcp/bridge/index — barrel exports', () => {
  it('exports wireBridges and all four bridge factories', () => {
    expect(typeof wireBridges).toBe('function');
    expect(typeof createGitBridge).toBe('function');
    expect(typeof createSkillsBridge).toBe('function');
    expect(typeof createAgentsBridge).toBe('function');
    expect(typeof createMemoryBridge).toBe('function');
  });
});

describe('wireBridges — registry wiring', () => {
  it('registers the built-in tools plus bridge-backed tools', () => {
    const server = createArtibotMcpServer();
    const summary = wireBridges(server, { pluginRoot: process.cwd() });

    // At least every built-in tool must be registered.
    expect(summary.registered).toBeGreaterThanOrEqual(builtinTools().length);
    expect(summary.total).toBe(summary.registered);

    // Bridge-backed tools must be present alongside the built-ins.
    expect(summary.names).toContain('artibot.list_agents');
    expect(summary.names).toContain('artibot.search_memory');
    expect(summary.names).toContain('artibot.git_status');
  });

  it('makes the server tools/list non-empty (the bug this fixes)', async () => {
    const server = createArtibotMcpServer();

    // Before wiring: empty catalog (the silent-failure symptom).
    const before = server.registry.listTools().tools;
    expect(before).toHaveLength(0);

    wireBridges(server, { pluginRoot: process.cwd() });

    // After wiring: a real catalog over the MCP dispatch path.
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const resp = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(Array.isArray(resp.result.tools)).toBe(true);
    expect(resp.result.tools.length).toBeGreaterThan(0);
  });

  it('is idempotent — re-wiring registers nothing new', () => {
    const server = createArtibotMcpServer();
    const first = wireBridges(server, { pluginRoot: process.cwd() });
    const second = wireBridges(server, { pluginRoot: process.cwd() });
    expect(first.registered).toBeGreaterThan(0);
    expect(second.registered).toBe(0);
    // Total tool count is unchanged after the second pass.
    expect(server.registry.listTools().tools.length).toBe(first.names.length);
  });

  it('throws a clear error when given a server without a registry', () => {
    expect(() => wireBridges({}, {})).toThrow(/registry/);
    expect(() => wireBridges(null, {})).toThrow(/registry/);
  });

  it('does no bridge I/O at wire time (handlers are lazy)', () => {
    // Wiring must not call git/fs — it only registers definitions. We assert
    // by wiring against a bogus pluginRoot: if any bridge eagerly probed the
    // filesystem/git, this would throw. It must not.
    const server = createArtibotMcpServer();
    expect(() =>
      wireBridges(server, { pluginRoot: '/no/such/dir/zzz' }),
    ).not.toThrow();
  });
});

describe('wireBridges — bridge-backed tool handlers are callable', () => {
  it('git_status handler returns a content block via the registry', async () => {
    const server = createArtibotMcpServer();
    wireBridges(server, { pluginRoot: process.cwd() });
    const result = await server.registry.callTool('artibot.git_status', {});
    // git may or may not be a repo in CI; either a content block or an
    // isError block is acceptable — what matters is the tool is reachable.
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe('text');
  });

  it('search_memory surfaces a structured error when no store is wired', async () => {
    const server = createArtibotMcpServer();
    wireBridges(server, { pluginRoot: process.cwd() });
    const result = await server.registry.callTool('artibot.search_memory', {
      query: 'anything',
    });
    // memory bridge has no retriever/manager wired → ok:false → isError.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no retriever or memoryManager/);
  });
});
