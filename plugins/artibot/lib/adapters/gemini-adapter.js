/**
 * Gemini CLI adapter.
 * Converts Artibot skills/agents/commands to Gemini CLI extension format.
 *
 * Gemini CLI compatibility score: 9/10 (most similar structure to Claude Code).
 * - plugin.json -> gemini-extension.json (nearly 1:1 field mapping)
 * - CLAUDE.md -> GEMINI.md (content preserved, filename changed)
 * - commands/*.md -> commands/*.toml (TOML format conversion)
 * - skills/ -> skills/ (SKILL.md format directly compatible)
 * - hooks/hooks.json -> hooks/hooks.json (same pattern)
 *
 * @module lib/adapters/gemini-adapter
 */

import path from 'node:path';
import { BaseAdapter } from './base-adapter.js';

export class GeminiAdapter extends BaseAdapter {
  get platformId() {
    return 'gemini-cli';
  }

  get platformName() {
    return 'Gemini CLI';
  }

  get instructionFileName() {
    return 'GEMINI.md';
  }

  get skillsDir() {
    return '.agent/skills';
  }

  /**
   * Convert a SKILL.md to Gemini CLI format.
   * Gemini CLI supports SKILL.md natively, so this is largely a passthrough
   * with minor adjustments to platform-specific references.
   */
  convertSkill(skill) {
    const frontmatter = buildFrontmatter({
      name: skill.name,
      description: cleanDescription(skill.description),
    });

    const body = stripClaudeSpecificRefs(skill.content);

    return {
      path: path.join(this.skillsDir, skill.dirName, 'SKILL.md'),
      content: `${frontmatter}\n${body}`,
    };
  }

  /**
   * Convert an agent definition to Gemini CLI format.
   * Gemini CLI uses Markdown-based agent definitions similar to Claude Code.
   * Agent Teams API references are stripped (Claude-exclusive).
   */
  convertAgent(agent) {
    const content = stripAgentTeamsRefs(agent.content);
    return {
      path: path.join('agents', `${agent.name}.md`),
      content,
    };
  }

  /**
   * Convert a command definition from Markdown to TOML.
   * Gemini CLI uses TOML-based command files in commands/ directory.
   */
  convertCommand(command) {
    const toml = markdownCommandToToml(command);
    return {
      path: path.join('commands', `${command.name}.toml`),
      content: toml,
    };
  }

  /**
   * Generate gemini-extension.json manifest from artibot.config.json.
   */
  generateManifest() {
    const manifest = {
      name: 'artibot',
      version: this.config.version ?? '1.1.0',
      description: 'Artibot - AI Agent Teams Orchestration Extension for Gemini CLI',
      contextFileName: 'GEMINI.md',
      excludeTools: [],
      settings: [],
    };

    return {
      path: 'gemini-extension.json',
      content: JSON.stringify(manifest, null, 2) + '\n',
    };
  }
}

/**
 * Build YAML frontmatter string from key-value pairs.
 */
function buildFrontmatter(fields) {
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

/**
 * Clean description text (trim trailing whitespace per line).
 */
function cleanDescription(desc) {
  if (!desc) return '';
  return desc
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Remove Claude Code-specific references from skill content.
 * Keeps the content portable across platforms.
 */
function stripClaudeSpecificRefs(content) {
  return content
    .replace(/\.claude\/skills\//g, '.agent/skills/')
    .replace(/Claude Code/g, 'AI Agent')
    .replace(/CLAUDE\.md/g, 'GEMINI.md');
}

/**
 * Remove Agent Teams API-specific content from agent definitions.
 * Team orchestration is Claude-exclusive; other platforms use single-agent mode.
 */
function stripAgentTeamsRefs(content) {
  return content
    .replace(/TeamCreate|TeamDelete/g, '(team coordination)')
    .replace(/SendMessage\(type: "(?:broadcast|shutdown_request|shutdown_response|plan_approval_response)"\)/g, '(agent communication)')
    .replace(/CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/g, '(platform agent teams)')
    .replace(/Claude Code/g, 'AI Agent Platform');
}

/**
 * Convert a Markdown command definition to TOML format for Gemini CLI.
 */
function markdownCommandToToml(command) {
  const name = command.name;
  const desc = extractFirstParagraph(command.content);

  const lines = [
    `# ${name} command`,
    `# Auto-generated from Artibot command definition`,
    '',
    `[command]`,
    `name = "${name}"`,
    `description = "${escapeToml(desc)}"`,
    '',
    `[command.prompt]`,
    `text = """`,
    command.content.trim(),
    `"""`,
  ];

  return lines.join('\n') + '\n';
}

/**
 * Extract the first non-empty paragraph from markdown content.
 */
function extractFirstParagraph(content) {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 200);
    }
  }
  return '';
}

/**
 * Escape special characters for TOML string values.
 */
function escapeToml(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
