/**
 * MCP tool: get Artibot skill content.
 *
 * Returns the raw SKILL.md text for a given skill name. Path traversal is
 * blocked (name must match [a-z0-9-]). Read-only.
 *
 * @module lib/mcp/tools/get-skill
 */

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { getPluginRoot } from '../../core/platform.js';

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
    throw new Error(`invalid skill name: '${name}' (expected [a-z0-9-]+ )`);
  }
  const skillPath = path.join(getPluginRoot(), 'skills', name, 'SKILL.md');
  try {
    await stat(skillPath);
  } catch {
    throw new Error(`skill not found: ${name}`);
  }
  const body = await readFile(skillPath, 'utf-8');
  return {
    content: [
      { type: 'text', text: body },
    ],
    metadata: { name, path: skillPath, bytes: body.length },
  };
}

export const getSkillTool = Object.freeze({
  name: 'artibot.get_skill',
  description: 'Fetch the raw SKILL.md content for a named Artibot skill.',
  inputSchema: INPUT_SCHEMA,
  handler,
});
