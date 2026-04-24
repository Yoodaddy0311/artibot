/**
 * Built-in Artibot MCP tool exports + bundle helper.
 *
 * @module lib/mcp/tools
 */

import { listSkillsTool } from './list-skills.js';
import { listAgentsTool } from './list-agents.js';
import { getSkillTool } from './get-skill.js';
import { getAgentTool } from './get-agent.js';
import { getMemoryStatsTool } from './get-memory-stats.js';

export { listSkillsTool } from './list-skills.js';
export { listAgentsTool } from './list-agents.js';
export { getSkillTool } from './get-skill.js';
export { getAgentTool } from './get-agent.js';
export { getMemoryStatsTool } from './get-memory-stats.js';

/**
 * Return the canonical built-in tool bundle in registration order.
 *
 * @returns {Array<object>}
 */
export function builtinTools() {
  return [
    listSkillsTool,
    listAgentsTool,
    getSkillTool,
    getAgentTool,
    getMemoryStatsTool,
  ];
}
