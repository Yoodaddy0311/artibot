/**
 * MCP tool: list Artibot agents.
 *
 * Thin wrapper around the existing `lib/core/agent-registry` so MCP clients
 * can discover the 28-agent roster. Read-only.
 *
 * @module lib/mcp/tools/list-agents
 */

import { listAgents, loadAgentRegistry } from '../../core/agent-registry.js';

const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    lifecycle: { type: 'string' },
    includePath: { type: 'boolean' },
  },
});

async function handler(args = {}) {
  const lifecycleFilter = typeof args.lifecycle === 'string' ? args.lifecycle : null;
  const includePath = args.includePath === true;
  let registry;
  try {
    registry = await loadAgentRegistry();
  } catch (err) {
    throw new Error(`failed to load agent registry: ${err.message}`, { cause: err });
  }
  const names = await listAgents();
  const entries = names.map((name) => {
    const e = registry.get(name);
    const out = {
      name: e.name,
      description: e.description,
      capabilities: e.capabilities,
      lifecycle: e.lifecycle,
    };
    if (e.model) out.model = e.model;
    if (includePath) out.path = e.path;
    return out;
  });
  const filtered = lifecycleFilter
    ? entries.filter((e) => e.lifecycle === (lifecycleFilter === 'null' ? null : lifecycleFilter))
    : entries;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { count: filtered.length, total: entries.length, agents: filtered },
          null,
          2,
        ),
      },
    ],
  };
}

export const listAgentsTool = Object.freeze({
  name: 'artibot.list_agents',
  description: 'List Artibot agents registered under plugins/artibot/agents/*.md.',
  inputSchema: INPUT_SCHEMA,
  handler,
});
