/**
 * MCP tool: list Artibot skills.
 *
 * Scans `skills/<name>/SKILL.md` under the plugin root and returns a
 * structured inventory. Read-only; no mutation of the filesystem.
 *
 * @module lib/mcp/tools/list-skills
 */

import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { getPluginRoot } from '../../core/platform.js';

const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    prefix: { type: 'string' },
    limit: { type: 'integer' },
  },
});

async function collectSkillDirs(root) {
  const skillsDir = path.join(root, 'skills');
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillPath = path.join(skillsDir, e.name, 'SKILL.md');
    try {
      const st = await stat(skillPath);
      dirs.push({ name: e.name, path: skillPath, mtimeMs: st.mtimeMs });
    } catch {
      // skip dirs without a SKILL.md
    }
  }
  return dirs.sort((a, b) => a.name.localeCompare(b.name));
}

async function handler(args = {}) {
  const root = getPluginRoot();
  let skills;
  try {
    skills = await collectSkillDirs(root);
  } catch (err) {
    throw new Error(`failed to read skills directory: ${err.message}`);
  }
  let filtered = skills;
  if (typeof args.prefix === 'string' && args.prefix.length > 0) {
    filtered = filtered.filter((s) => s.name.startsWith(args.prefix));
  }
  if (Number.isInteger(args.limit) && args.limit > 0) {
    filtered = filtered.slice(0, args.limit);
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            count: filtered.length,
            total: skills.length,
            skills: filtered.map((s) => ({ name: s.name, path: s.path })),
          },
          null,
          2,
        ),
      },
    ],
  };
}

export const listSkillsTool = Object.freeze({
  name: 'artibot.list_skills',
  description: 'List Artibot skills registered under the plugin root (skills/*/SKILL.md).',
  inputSchema: INPUT_SCHEMA,
  handler,
});
