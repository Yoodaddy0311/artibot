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
// Skill Frontmatter (extended)
// ---------------------------------------------------------------------------

/** Claude Code-specific frontmatter fields stripped during cross-platform export. */
const CLAUDE_ONLY_FIELDS = new Set([
  'agent', 'allowed-tools', 'user-invocable', 'disable-model-invocation',
  'context', 'argument-hint', 'progressive_disclosure',
]);

/**
 * Build extended skill frontmatter with platform filtering.
 * Includes common fields (triggers, category, level, platforms) and strips
 * Claude Code-specific fields, preserving them as YAML comments.
 *
 * @param {object} skill - Parsed skill definition
 * @param {string} skill.name
 * @param {string} skill.description
 * @param {string[]} [skill.triggers]
 * @param {string} [skill.category]
 * @param {number|string} [skill.level]
 * @param {string[]} [skill.platforms]
 * @param {string} [skill.tokens]
 * @param {string[]} [skill.agents]
 * @param {Record<string, unknown>} [skill.extraFields] - All other frontmatter fields
 * @returns {string} YAML frontmatter string
 */
export function buildSkillFrontmatter(skill) {
  const fields = {
    name: skill.name,
    description: cleanDescription(skill.description),
  };

  if (skill.triggers?.length) fields.triggers = skill.triggers;
  if (skill.category) fields.category = skill.category;
  if (skill.level !== null && skill.level !== undefined) fields.level = String(skill.level);
  if (skill.platforms?.length) fields.platforms = skill.platforms;
  if (skill.tokens) fields.tokens = skill.tokens;
  if (skill.agents?.length) fields.agents = skill.agents;

  const frontmatter = buildFrontmatter(fields);

  // Preserve Claude-only fields as comments for traceability
  const commentLines = [];
  const extra = skill.extraFields || {};
  for (const [key, value] of Object.entries(extra)) {
    if (CLAUDE_ONLY_FIELDS.has(key)) {
      const serialized = Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
      commentLines.push(`# claude-only: ${key}: ${serialized}`);
    }
  }

  if (commentLines.length === 0) return frontmatter;

  // Insert comments before closing ---
  const lines = frontmatter.split('\n');
  const closingIdx = lines.lastIndexOf('---');
  lines.splice(closingIdx, 0, ...commentLines);
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
 * These replacements are **redaction labels, not platform equivalents**. Unlike
 * the Antigravity transformer in `scripts/export-to-tool.mjs`, which maps onto a
 * real Agent Manager, Cursor/Codex/Gemini get no claim that they can delegate —
 * the label marks where a Claude-only call stood. `Agent(...)` is treated the
 * same way for that reason: inventing a per-platform spawn verb here would make
 * the exported file assert a capability that was never checked.
 *
 * ── What this cannot see (repo convention: state it next to the gate) ──────────
 *
 *  1. **Bare `Agent` prose.** The `Agent` rule requires a `(` because `Agent` is
 *     an ordinary English word; `TeamCreate`/`TeamDelete` can be matched bare
 *     since nothing else spells them. So "delegate with the Agent tool" survives
 *     untranslated by design.
 *  2. **Nested parentheses** — `[^)]*` stops at the first `)`. Measured
 *     2026-08-15: zero occurrences in `agents/`, the only input these adapters
 *     receive.
 *  3. **Fenced code blocks are redacted like any other text.** This is a plain
 *     string replacement over the whole body, so an example inside ``` ``` ```
 *     becomes prose: `Agent(planner)` turns into `(agent delegation)`. Measured
 *     2026-08-15: 34 of the 73 `Agent(` in `agents/` are inside fences (all in
 *     `orchestrator.md`). Intended — the example names an API the target platform
 *     lacks — but exported code blocks are illustrative, not runnable. Every rule
 *     here has always done this; the `Agent` line did not introduce it.
 *  4. **Frontmatter `tools:`** is not this function's input; adapters build that
 *     separately, so a retired tool name declared there is invisible here.
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
    // The `\b` keeps this off the tail of identifiers such as `createAgent(`,
    // and no `Task*` tool (TaskCreate/TaskUpdate/TaskList/TaskGet/TaskStop) can
    // match it — those are current tools and must survive untouched.
    .replace(/\bAgent\([^)]*\)/g, '(agent delegation)')
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
    .replace(/\$\{CLAUDE_SKILL_DIR\}\//g, './')
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, '.')
    .replace(/\.claude\/skills\//g, mapping.skillsPath)
    .replace(/Claude Code/g, mapping.platformName)
    .replace(/CLAUDE\.md/g, mapping.instructionFile);
}
