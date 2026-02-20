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
import { buildFrontmatter, cleanDescription, stripAgentTeamsRefs, stripClaudeSpecificRefs } from './adapter-utils.js';

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

    const body = stripClaudeSpecificRefs(skill.content, {
      skillsPath: '.agent/skills/',
      platformName: 'AI Agent',
      instructionFile: 'GEMINI.md',
    });

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
 * Convert a Markdown command definition to TOML format for Gemini CLI.
 */
function markdownCommandToToml(command) {
  const name = command.name;
  const desc = extractFirstParagraph(command.content);

  // Before writing to TOML body, escape triple quotes
  const body = command.content.trim();
  const safeBody = body.replace(/"""/g, '\\"\\"\\"');

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
    safeBody,
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
