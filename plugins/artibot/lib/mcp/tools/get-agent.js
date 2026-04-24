/**
 * MCP tool: get Artibot agent content.
 *
 * Returns the raw `<agent>.md` text plus parsed frontmatter metadata (via
 * `lib/core/agent-registry`). Read-only; path traversal is blocked.
 *
 * @module lib/mcp/tools/get-agent
 */

import { readFile } from 'node:fs/promises';
import { getAgent } from '../../core/agent-registry.js';

const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
  },
});

const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

async function handler(args = {}) {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!SAFE_NAME.test(name)) {
    throw new Error(`invalid agent name: '${name}' (expected [a-z0-9-]+ )`);
  }
  const entry = await getAgent(name);
  if (!entry) {
    throw new Error(`agent not found: ${name}`);
  }
  const body = await readFile(entry.path, 'utf-8');
  return {
    content: [
      { type: 'text', text: body },
    ],
    metadata: {
      name: entry.name,
      path: entry.path,
      lifecycle: entry.lifecycle,
      capabilities: entry.capabilities,
      model: entry.model,
      bytes: body.length,
    },
  };
}

export const getAgentTool = Object.freeze({
  name: 'artibot.get_agent',
  description: 'Fetch the raw .md content for a named Artibot agent plus frontmatter metadata.',
  inputSchema: INPUT_SCHEMA,
  handler,
});
