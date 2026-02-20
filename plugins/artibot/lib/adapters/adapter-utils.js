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
 * @param {{ envLabel?: string }} [mapping] - Platform-specific replacement labels
 * @param {string} [mapping.envLabel] - Replacement for CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
 *   (default: '(platform agent teams)')
 * @returns {string}
 */
export function stripAgentTeamsRefs(content, mapping = {}) {
  const envLabel = mapping.envLabel ?? '(platform agent teams)';
  return content
    .replace(/TeamCreate|TeamDelete/g, '(team coordination)')
    .replace(/SendMessage\(type: "(?:broadcast|shutdown_request|shutdown_response|plan_approval_response)"\)/g, '(agent communication)')
    .replace(/CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/g, envLabel)
    .replace(/Claude Code/g, 'AI Agent Platform');
}

// ---------------------------------------------------------------------------
// Claude-Specific Reference Stripping
// ---------------------------------------------------------------------------

/**
 * Remove Claude Code-specific references from skill content.
 * Replaces Claude-specific paths and names with platform-appropriate equivalents.
 *
 * @param {string} content
 * @param {{ skillsPath: string, platformName: string, instructionFile: string }} mapping
 * @param {string} mapping.skillsPath - Replacement for '.claude/skills/' (e.g. '.agent/skills/')
 * @param {string} mapping.platformName - Replacement for 'Claude Code' (e.g. 'AI Agent')
 * @param {string} mapping.instructionFile - Replacement for 'CLAUDE.md' (e.g. 'GEMINI.md')
 * @returns {string}
 */
export function stripClaudeSpecificRefs(content, mapping) {
  return content
    .replace(/\.claude\/skills\//g, mapping.skillsPath)
    .replace(/Claude Code/g, mapping.platformName)
    .replace(/CLAUDE\.md/g, mapping.instructionFile);
}
