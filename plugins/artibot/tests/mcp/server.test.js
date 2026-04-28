/**
 * Tests for the Artibot MCP server — JSON-RPC 2.0 over stdio.
 *
 * Covers:
 *   - handshake (initialize + capabilities)
 *   - method routing (tools/list, tools/call, resources, prompts)
 *   - validation and error codes (invalid request, method not found,
 *     invalid params, parse error, internal error)
 *   - stdio framing (handleLine end-to-end, newline-delimited JSON)
 *   - built-in tool sanity (list-agents, list-skills)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createArtibotMcpServer,
  ERROR_CODES,
  PROTOCOL_VERSION,
} from '../../lib/mcp/server.js';
import { createToolRegistry, validateArgs } from '../../lib/mcp/tool-registry.js';
import { builtinTools } from '../../lib/mcp/tools/index.js';

function initializedServer(overrides = {}) {
  const server = createArtibotMcpServer(overrides);
  return {
    server,
    async init() {
      await server.dispatch({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { clientInfo: { name: 'vitest', version: '0' }, capabilities: {} },
      });
      return server;
    },
  };
}

describe('tool-registry', () => {
  let registry;
  beforeEach(() => {
    registry = createToolRegistry();
  });

  it('registers and lists tools', () => {
    registry.registerTool({
      name: 'echo',
      description: 'echo args',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      handler: async (args) => ({ content: [{ type: 'text', text: args.msg || '' }] }),
    });
    const list = registry.listTools();
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0].name).toBe('echo');
    expect(list.tools[0].description).toBe('echo args');
    expect(list.tools[0].inputSchema.type).toBe('object');
  });

  it('rejects duplicate registration unless replace:true', () => {
    registry.registerTool({ name: 'a', handler: async () => 'ok' });
    expect(() => registry.registerTool({ name: 'a', handler: async () => 'ok' })).toThrow(
      /already registered/,
    );
    expect(() =>
      registry.registerTool({ name: 'a', handler: async () => 'ok' }, { replace: true }),
    ).not.toThrow();
  });

  it('requires non-empty name and function handler', () => {
    expect(() => registry.registerTool({ name: '', handler: async () => {} })).toThrow();
    expect(() => registry.registerTool({ name: 'x', handler: 'nope' })).toThrow();
    expect(() => registry.registerTool(null)).toThrow();
  });

  it('calls a tool and returns MCP content shape', async () => {
    registry.registerTool({
      name: 'upper',
      handler: (args) => args.s.toUpperCase(),
    });
    const res = await registry.callTool('upper', { s: 'hi' });
    expect(res.content).toEqual([{ type: 'text', text: 'HI' }]);
    expect(res.isError).toBeUndefined();
  });

  it('returns isError result when tool throws', async () => {
    registry.registerTool({
      name: 'boom',
      handler: () => {
        throw new Error('kaboom');
      },
    });
    const res = await registry.callTool('boom', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/kaboom/);
  });

  it('validates input schema and surfaces clear error', async () => {
    registry.registerTool({
      name: 'needName',
      inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      handler: (args) => `hi ${args.name}`,
    });
    const res = await registry.callTool('needName', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing required field 'name'/);
    const res2 = await registry.callTool('needName', { name: 123 });
    expect(res2.isError).toBe(true);
    expect(res2.content[0].text).toMatch(/expected string/);
  });

  it('wraps plain string / object returns into content array', async () => {
    registry.registerTool({ name: 's', handler: () => 'plain' });
    registry.registerTool({ name: 'o', handler: () => ({ k: 1 }) });
    const s = await registry.callTool('s', {});
    expect(s.content[0].text).toBe('plain');
    const o = await registry.callTool('o', {});
    expect(JSON.parse(o.content[0].text)).toEqual({ k: 1 });
  });

  it('callTool on unknown tool returns isError', async () => {
    const res = await registry.callTool('ghost', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/tool not found/);
  });

  it('validates enum and array items', () => {
    const okE = validateArgs({ mode: 'a' }, { type: 'object', properties: { mode: { enum: ['a', 'b'] } } });
    expect(okE.ok).toBe(true);
    const badE = validateArgs({ mode: 'c' }, { type: 'object', properties: { mode: { enum: ['a', 'b'] } } });
    expect(badE.ok).toBe(false);
    const okA = validateArgs({ xs: [1, 2] }, { type: 'object', properties: { xs: { type: 'array', items: { type: 'integer' } } } });
    expect(okA.ok).toBe(true);
    const badA = validateArgs({ xs: [1, 'bad'] }, { type: 'object', properties: { xs: { type: 'array', items: { type: 'integer' } } } });
    expect(badA.ok).toBe(false);
  });

  it('size, hasTool, getTool, unregister round-trip', () => {
    registry.registerTool({ name: 't1', handler: () => 'a' });
    registry.registerTool({ name: 't2', handler: () => 'b' });
    expect(registry.size()).toBe(2);
    expect(registry.hasTool('t1')).toBe(true);
    expect(registry.getTool('t2').name).toBe('t2');
    expect(registry.getTool('nope')).toBeNull();
    expect(registry.unregister('t1')).toBe(true);
    expect(registry.size()).toBe(1);
  });
});

describe('mcp-server handshake', () => {
  it('responds to initialize with protocolVersion, serverInfo, capabilities', async () => {
    const server = createArtibotMcpServer();
    const res = await server.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'vitest', version: '0' }, capabilities: {} },
    });
    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(res.result.serverInfo.name).toBe('artibot');
    expect(res.result.serverInfo.version).toBeTypeOf('string');
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.capabilities.resources).toBeDefined();
    expect(res.result.capabilities.prompts).toBeDefined();
  });

  it('treats initialized notification as no-op (no response)', async () => {
    const server = createArtibotMcpServer();
    await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res = await server.dispatch({ jsonrpc: '2.0', method: 'initialized' });
    expect(res).toBeNull();
  });

  it('rejects non-initialize calls before handshake with invalid request', async () => {
    const server = createArtibotMcpServer();
    const res = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
    expect(res.error.message).toMatch(/not initialized/);
  });

  it('allows ping before initialization', async () => {
    const server = createArtibotMcpServer();
    const res = await server.dispatch({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    expect(res.result).toEqual({});
    expect(res.error).toBeUndefined();
  });
});

describe('mcp-server routing', () => {
  it('tools/list returns the registered tool catalog', async () => {
    const registry = createToolRegistry();
    registry.registerTool({
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { m: { type: 'string' } } },
      handler: (a) => a.m || '',
    });
    const { init } = initializedServer({ registry });
    const server = await init();
    const res = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.result.tools).toHaveLength(1);
    expect(res.result.tools[0].name).toBe('echo');
  });

  it('tools/call invokes the registered handler', async () => {
    const registry = createToolRegistry();
    registry.registerTool({ name: 'echo', handler: (a) => `got:${a.m}` });
    const { init } = initializedServer({ registry });
    const server = await init();
    const res = await server.dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { m: 'hi' } },
    });
    expect(res.result.content[0].text).toBe('got:hi');
    expect(res.result.isError).toBeUndefined();
  });

  it('tools/call returns method_not_found when tool missing', async () => {
    const { init } = initializedServer();
    const server = await init();
    const res = await server.dispatch({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'ghost', arguments: {} },
    });
    expect(res.error.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('tools/call returns invalid_params when payload malformed', async () => {
    const { init } = initializedServer();
    const server = await init();
    const res = await server.dispatch({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { wrong: 'shape' },
    });
    expect(res.error.code).toBe(ERROR_CODES.INVALID_PARAMS);
  });

  it('unknown top-level method returns method_not_found', async () => {
    const { init } = initializedServer();
    const server = await init();
    const res = await server.dispatch({ jsonrpc: '2.0', id: 6, method: 'mystery/op' });
    expect(res.error.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('invalid JSON-RPC envelope surfaces invalid_request', async () => {
    const server = createArtibotMcpServer();
    const res = await server.dispatch({ foo: 'bar' });
    expect(res.error.code).toBe(ERROR_CODES.INVALID_REQUEST);
  });
});

describe('mcp-server resources + prompts', () => {
  it('resources/list enumerates registered resources', async () => {
    const resources = new Map();
    resources.set('artibot://skills', {
      meta: { name: 'skills-index', description: 'all skills', mimeType: 'application/json' },
      loader: async () => JSON.stringify({ n: 0 }),
    });
    const { init } = initializedServer({ resources });
    const server = await init();
    const res = await server.dispatch({ jsonrpc: '2.0', id: 10, method: 'resources/list' });
    expect(res.result.resources).toHaveLength(1);
    expect(res.result.resources[0].uri).toBe('artibot://skills');
    expect(res.result.resources[0].mimeType).toBe('application/json');
  });

  it('resources/read invokes loader and wraps text content', async () => {
    const resources = new Map();
    resources.set('artibot://hello', async () => 'world');
    const { init } = initializedServer({ resources });
    const server = await init();
    const res = await server.dispatch({
      jsonrpc: '2.0',
      id: 11,
      method: 'resources/read',
      params: { uri: 'artibot://hello' },
    });
    expect(res.result.contents[0].text).toBe('world');
    expect(res.result.contents[0].uri).toBe('artibot://hello');
  });

  it('resources/read 404s unknown uri', async () => {
    const { init } = initializedServer();
    const server = await init();
    const res = await server.dispatch({
      jsonrpc: '2.0',
      id: 12,
      method: 'resources/read',
      params: { uri: 'artibot://missing' },
    });
    expect(res.error.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('prompts/list + prompts/get work', async () => {
    const prompts = new Map();
    prompts.set('greet', {
      description: 'greet the user',
      arguments: [{ name: 'who', required: true }],
      render: async (args) => [
        { role: 'user', content: { type: 'text', text: `Hello ${args.who}` } },
      ],
    });
    const { init } = initializedServer({ prompts });
    const server = await init();
    const list = await server.dispatch({ jsonrpc: '2.0', id: 20, method: 'prompts/list' });
    expect(list.result.prompts[0].name).toBe('greet');
    const got = await server.dispatch({
      jsonrpc: '2.0',
      id: 21,
      method: 'prompts/get',
      params: { name: 'greet', arguments: { who: 'world' } },
    });
    expect(got.result.messages[0].content.text).toBe('Hello world');
  });
});

describe('mcp-server stdio framing', () => {
  it('handleLine parses valid JSON and returns stringifiable response', async () => {
    const server = createArtibotMcpServer();
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const res = await server.handleLine(line);
    expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('handleLine returns parse_error for malformed JSON', async () => {
    const server = createArtibotMcpServer();
    const res = await server.handleLine('{not json');
    expect(res.error.code).toBe(ERROR_CODES.PARSE_ERROR);
  });

  it('handleLine returns null for empty lines (frame skip)', async () => {
    const server = createArtibotMcpServer();
    expect(await server.handleLine('')).toBeNull();
    expect(await server.handleLine('   \t  ')).toBeNull();
  });

  it('run() consumes a stream of lines and writes responses', async () => {
    const server = createArtibotMcpServer();
    const inputs = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' }),
    ];
    const outputs = [];
    async function* lines() {
      for (const l of inputs) yield l;
    }
    await server.run({
      read: lines(),
      write: (line) => {
        outputs.push(line.trim());
      },
    });
    // initialize + tools/list + shutdown = 3 responses (notification suppressed)
    expect(outputs).toHaveLength(3);
    const parsed = outputs.map((l) => JSON.parse(l));
    expect(parsed[0].id).toBe(1);
    expect(parsed[0].result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(parsed[1].id).toBe(2);
    expect(Array.isArray(parsed[1].result.tools)).toBe(true);
    expect(parsed[2].id).toBe(3);
  });
});

describe('mcp built-in tools', () => {
  it('exposes 5 canonical tools', () => {
    const tools = builtinTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'artibot.get_agent',
      'artibot.get_memory_stats',
      'artibot.get_skill',
      'artibot.list_agents',
      'artibot.list_skills',
    ]);
  });

  it('list_agents returns the 28-agent roster (live registry)', async () => {
    const registry = createToolRegistry();
    for (const t of builtinTools()) registry.registerTool(t);
    const res = await registry.callTool('artibot.list_agents', {});
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.total).toBe(28);
    expect(parsed.agents.some((a) => a.name === 'orchestrator')).toBe(true);
  });

  it('list_skills returns at least one skill', async () => {
    const registry = createToolRegistry();
    for (const t of builtinTools()) registry.registerTool(t);
    const res = await registry.callTool('artibot.list_skills', { limit: 3 });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.count).toBeLessThanOrEqual(3);
  });

  it('get_agent rejects path traversal and unknown agents', async () => {
    const registry = createToolRegistry();
    for (const t of builtinTools()) registry.registerTool(t);
    const bad = await registry.callTool('artibot.get_agent', { name: '../etc/passwd' });
    expect(bad.isError).toBe(true);
    const unknown = await registry.callTool('artibot.get_agent', { name: 'nonexistent-xyz' });
    expect(unknown.isError).toBe(true);
  });

  it('get_agent returns markdown body for a known agent', async () => {
    const registry = createToolRegistry();
    for (const t of builtinTools()) registry.registerTool(t);
    const res = await registry.callTool('artibot.get_agent', { name: 'orchestrator' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/---/); // frontmatter fences
  });

  it('get_memory_stats returns zeros when metrics file absent', async () => {
    const registry = createToolRegistry();
    for (const t of builtinTools()) registry.registerTool(t);
    const res = await registry.callTool('artibot.get_memory_stats', {
      metricsPath: '/tmp/__artibot_nonexistent_metrics__.json',
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.present).toBe(false);
    expect(parsed.layers.working.queries).toBe(0);
    expect(parsed.aggregate.rate).toBe(0);
  });
});
