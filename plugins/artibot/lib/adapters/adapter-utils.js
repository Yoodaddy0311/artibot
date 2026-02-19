/**
 * Shared utility functions for platform adapters.
 * Extracted from gemini-adapter, codex-adapter, cursor-adapter, and antigravity-adapter
 * to eliminate duplication.
 *
 * @module lib/adapters/adapter-utils
 */

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Build YAML frontmatter string from key-value pairs.
 *
 * @param {Record<string, string|string[]>} fields
 * @returns {string}
 */
export function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value.includes('\n')) {
      lines.push(`${key}: |`);
      for (const line of value.split('\n')) {
        lines.push(`  ${line}`);
      }
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Description Cleaning
// ---------------------------------------------------------------------------

/**
 * Clean description text (trim trailing whitespace per line).
 *
 * @param {string} desc
 * @returns {string}
 */
export function cleanDescription(desc) {
  if (!desc) return '';
  return desc
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Agent Teams Reference Stripping
// ---------------------------------------------------------------------------

/**
 * Remove Agent Teams API-specific content from agent definitions.
 * Team orchestration is Claude-exclusive; other platforms use single-agent mode.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripAgentTeamsRefs(content) {
  return content
    .replace(/TeamCreate|TeamDelete/g, '(team coordination)')
    .replace(/SendMessage\(type: "(?:broadcast|shutdown_request|shutdown_response|plan_approval_response)"\)/g, '(agent communication)')
    .replace(/CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/g, '(platform agent teams)')
    .replace(/Claude Code/g, 'AI Agent Platform');
}
