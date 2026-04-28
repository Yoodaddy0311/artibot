/**
 * Agents bridge — exposes the Artibot agent registry to MCP tools.
 *
 * Delegates to `lib/core/agent-registry.js` which parses frontmatter from
 * `plugins/artibot/agents/*.md` and caches by max-mtime. The bridge layers
 * an MCP-friendly, read-only surface on top:
 *
 *   - `listAgents()`          → sanitized entry list
 *   - `getAgent(name)`        → single entry + markdown body
 *   - Metadata (model, tools, capabilities, lifecycle, category-ish)
 *
 * Design contract:
 *   - Zero runtime deps.
 *   - Korean-path safe (no pathToFileURL).
 *   - Pure read-only — never writes, never mutates the upstream registry.
 *   - Returns `{ok: true, value}` / `{ok: false, error}` shapes to match the
 *     sibling bridges; the MCP tool layer adapts those into content blocks.
 *
 * @module lib/mcp/bridge/agents-bridge
 */

import { readFile } from 'node:fs/promises';
import {
  loadAgentRegistry,
  getAgent as registryGetAgent,
} from '../../core/agent-registry.js';

const MAX_DESCRIPTION_LEN = 280;

/**
 * Derive a rough "category" label from the tools/capabilities metadata.
 * Intentionally coarse — callers that want the full taxonomy should read
 * `plugins/artibot/docs/agent-taxonomy.md`.
 *
 * @param {{tools?: string[]|undefined, capabilities?: string[]}} entry
 * @returns {string}
 */
function deriveCategory(entry) {
  const caps = Array.isArray(entry.capabilities) ? entry.capabilities : [];
  if (caps.some((c) => typeof c === 'string' && /review|audit/i.test(c))) {
    return 'review';
  }
  if (caps.some((c) => typeof c === 'string' && /plan|architect|strategy/i.test(c))) {
    return 'planning';
  }
  if (caps.some((c) => typeof c === 'string' && /test|tdd|eval/i.test(c))) {
    return 'testing';
  }
  if (caps.some((c) => typeof c === 'string' && /doc|content|marketing|seo|copy/i.test(c))) {
    return 'content';
  }
  if (caps.some((c) => typeof c === 'string' && /backend|frontend|typescript|build|devops/i.test(c))) {
    return 'engineering';
  }
  return 'general';
}

/**
 * Shape a registry entry into an MCP-friendly summary.
 * @param {object} entry
 * @returns {object}
 */
function toSummary(entry) {
  const description = typeof entry.description === 'string'
    ? entry.description.slice(0, MAX_DESCRIPTION_LEN)
    : '';
  return {
    name: entry.name,
    description,
    capabilities: Array.isArray(entry.capabilities) ? [...entry.capabilities] : [],
    lifecycle: entry.lifecycle ?? null,
    model: entry.model ?? null,
    tools: Array.isArray(entry.tools) ? [...entry.tools] : [],
    category: deriveCategory(entry),
    path: entry.path,
  };
}

/**
 * Safe wrapper around a registry API that accepts either a real registry
 * (exported `listAgents` / `getAgent` functions) OR the core module's
 * default behavior.
 *
 * @param {object} [override]
 * @returns {{
 *   list: () => Promise<Array<object>>,
 *   get:  (name: string) => Promise<object | null>,
 *   getBody: (entry: object) => Promise<string>,
 * }}
 */
function resolveRegistry(override) {
  if (override && typeof override === 'object') {
    const list = typeof override.list === 'function'
      ? override.list
      : async () => {
        if (typeof override.listAgents === 'function') return override.listAgents();
        const map = typeof override.loadAgentRegistry === 'function'
          ? await override.loadAgentRegistry()
          : null;
        return map ? [...map.values()] : [];
      };
    const get = typeof override.get === 'function'
      ? override.get
      : (typeof override.getAgent === 'function' ? override.getAgent : null);
    const getBody = typeof override.getBody === 'function'
      ? override.getBody
      : async (entry) => (entry?.path ? readFile(entry.path, 'utf-8') : '');
    return {
      list,
      get: get || (async (name) => {
        const all = await list();
        return all.find((a) => a?.name === name) || null;
      }),
      getBody,
    };
  }
  return {
    // core/agent-registry.listAgents() returns a name-only string[]; the
    // bridge needs full entries, so walk the Map values directly.
    list: async () => {
      const map = await loadAgentRegistry();
      return [...map.values()];
    },
    get: registryGetAgent,
    getBody: async (entry) => (entry?.path ? readFile(entry.path, 'utf-8') : ''),
  };
}

/**
 * Create the agents bridge.
 *
 * @param {object} [deps]
 * @param {object} [deps.agentRegistry] - Custom registry with the shape
 *   `{list(), get(name), getBody(entry)}` or `{listAgents(), getAgent(name)}`.
 * @returns {{
 *   listAgents: () => Promise<{ok: boolean, value?: Array<object>, error?: string}>,
 *   getAgent:   (name: string) => Promise<{ok: boolean, value?: object, error?: string}>,
 * }}
 */
export function createAgentsBridge(deps = {}) {
  const registry = resolveRegistry(deps.agentRegistry);

  async function listAgents() {
    try {
      const entries = await registry.list();
      const value = Array.isArray(entries)
        ? entries.filter((e) => e && typeof e.name === 'string').map(toSummary)
        : [];
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function getAgent(name) {
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: 'agent name required' };
    }
    try {
      const entry = await registry.get(name);
      if (!entry) return { ok: false, error: `agent not found: ${name}` };
      let body = '';
      try {
        body = await registry.getBody(entry);
      } catch {
        body = '';
      }
      return {
        ok: true,
        value: {
          ...toSummary(entry),
          body,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return Object.freeze({ listAgents, getAgent });
}
