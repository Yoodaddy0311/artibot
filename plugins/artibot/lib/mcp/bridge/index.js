/**
 * MCP bridge barrel — wires Artibot's read-only bridges and built-in tools
 * into an MCP server's tool registry.
 *
 * `bin/artibot-mcp.mjs` calls `wireBridges(server, { pluginRoot })` right
 * after `createArtibotMcpServer(...)`. Before this module existed the bin
 * imported `../lib/mcp/bridges/index.js` (plural, non-existent) — the import
 * threw, was swallowed by the loader's try/catch, and the server booted with
 * an EMPTY registry, so `tools/list` returned `[]` and nothing was callable.
 * This barrel is the missing link.
 *
 * What it registers:
 *   1. The 5 built-in tools (`builtinTools()`): list/get skills, list/get
 *      agents, get_memory_stats. These are self-contained (read lib/core
 *      directly) and form the baseline `tools/list`.
 *   2. Bridge-backed tools that expose the richer read-only bridges:
 *      - `artibot.search_memory`  (memory-bridge, redacted)
 *      - `artibot.search_skills`  (skills-bridge keyword search)
 *      - `artibot.git_status` / `git_log` / `git_branches` (git-bridge, R/O)
 *
 * Design contract (mirrors the sibling bridge modules):
 *   - Zero runtime deps.
 *   - Korean-path safe (no pathToFileURL; relative ESM imports only).
 *   - Read-only: bridges are constructed lazily and never perform I/O or
 *     mutate state at wire time — all work happens inside tool handlers when
 *     a client actually calls a tool. Wiring stays fast and side-effect-free.
 *   - Never throws out of `wireBridges`: a single bad tool registration is
 *     logged to stderr and skipped so the server still boots with the rest.
 *
 * @module lib/mcp/bridge/index
 */

import { builtinTools } from '../tools/index.js';
import { createGitBridge } from './git-bridge.js';
import { createSkillsBridge } from './skills-bridge.js';
import { createMemoryBridge } from './memory-bridge.js';

export { createGitBridge } from './git-bridge.js';
export { createSkillsBridge } from './skills-bridge.js';
export { createAgentsBridge } from './agents-bridge.js';
export { createMemoryBridge } from './memory-bridge.js';

/**
 * Adapt a bridge method returning `{ok, value|error}` into an MCP tool
 * handler. On `ok:false` it throws so the tool-registry surfaces the error as
 * `isError: true`; on success it JSON-stringifies the value into a text block.
 *
 * @param {(args: object) => Promise<{ok: boolean, value?: unknown, error?: string}>} fn
 * @returns {(args: object) => Promise<{content: Array<{type: string, text: string}>}>}
 */
function toToolHandler(fn) {
  return async (args = {}) => {
    const res = await fn(args);
    if (!res || res.ok !== true) {
      throw new Error(res?.error || 'bridge operation failed');
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.value, null, 2) }] };
  };
}

/**
 * Build the bridge-backed tool definitions. Bridges are created here but do
 * NO I/O until a handler runs, keeping wire-time side-effect-free.
 *
 * @param {{ pluginRoot?: string }} [opts]
 * @returns {Array<{name: string, description: string, inputSchema: object, handler: Function}>}
 */
function bridgeTools(opts = {}) {
  const cwd = typeof opts.pluginRoot === 'string' ? opts.pluginRoot : undefined;
  const memory = createMemoryBridge({});
  const skills = createSkillsBridge();
  const git = createGitBridge(cwd ? { cwd } : {});

  return [
    {
      name: 'artibot.search_memory',
      description: 'Search Artibot hierarchical memory (redacted, read-only).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
      handler: toToolHandler((args) => memory.searchMemory(args)),
    },
    {
      name: 'artibot.search_skills',
      description: 'Keyword-search Artibot skills by name/description/tags.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
      handler: toToolHandler((args) => skills.searchSkills(args)),
    },
    {
      name: 'artibot.git_status',
      description: 'Read-only `git status --porcelain` for the plugin repo.',
      inputSchema: { type: 'object', properties: {} },
      handler: toToolHandler(() => git.status()),
    },
    {
      name: 'artibot.git_log',
      description: 'Read-only `git log --oneline -10` for the plugin repo.',
      inputSchema: { type: 'object', properties: {} },
      handler: toToolHandler(() => git.log()),
    },
    {
      name: 'artibot.git_branches',
      description: 'Read-only `git branch --list` for the plugin repo.',
      inputSchema: { type: 'object', properties: {} },
      handler: toToolHandler(() => git.branches()),
    },
  ];
}

/**
 * Register one tool, tolerating duplicates and bad defs so a single failure
 * never aborts wiring of the rest.
 *
 * @param {object} registry - server.registry (from createToolRegistry).
 * @param {object} tool - tool definition.
 * @param {(msg: string) => void} warn - stderr logger.
 * @returns {boolean} true if newly registered.
 */
function safeRegister(registry, tool, warn) {
  if (registry.hasTool?.(tool.name)) return false;
  try {
    registry.registerTool(tool);
    return true;
  } catch (err) {
    warn(`[artibot-mcp] skipped tool '${tool?.name}': ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Wire built-in tools and read-only bridges into an MCP server's registry.
 *
 * Idempotent and never throws: pre-existing tools are skipped, bad defs are
 * logged and skipped. Returns a small summary so callers/tests can assert.
 *
 * @param {object} server - object exposing `.registry` (createArtibotMcpServer).
 * @param {{ pluginRoot?: string }} [opts]
 * @returns {{ registered: number, total: number, names: string[] }}
 */
export function wireBridges(server, opts = {}) {
  const registry = server && server.registry;
  if (!registry || typeof registry.registerTool !== 'function') {
    throw new Error('wireBridges: server.registry with registerTool is required');
  }
  const warn = (m) => process.stderr.write(`${m}\n`);
  const all = [...builtinTools(), ...bridgeTools(opts)];
  let registered = 0;
  for (const tool of all) {
    if (safeRegister(registry, tool, warn)) registered += 1;
  }
  const names = (registry.listTools?.()?.tools ?? []).map((t) => t.name);
  return { registered, total: all.length, names };
}
