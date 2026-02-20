/**
 * Cursor IDE adapter.
 * Converts Artibot skills/agents/commands to Cursor format.
 *
 * Cursor compatibility score: 6/10 (structural differences in agent definition).
 * - CLAUDE.md -> .cursorrules (plain text rules)
 * - agents/*.md -> .cursor/modes.json (JSON agent modes)
 * - skills/ -> .cursor/skills/ (SKILL.md compatible)
 * - commands/ -> custom prompts (slash commands limited)
 * - hooks -> Cursor hooks mapping
 *
 * @module lib/adapters/cursor-adapter
 */

import path from 'node:path';
import { BaseAdapter } from './base-adapter.js';
import { buildFrontmatter, cleanDescription, stripAgentTeamsRefs, stripClaudeSpecificRefs } from './adapter-utils.js';

export class CursorAdapter extends BaseAdapter {
  get platformId() {
    return 'cursor';
  }

  get platformName() {
    return 'Cursor IDE';
  }

  get instructionFileName() {
    return '.cursorrules';
  }

  get skillsDir() {
    return '.cursor/skills';
  }

  /**
   * Convert a SKILL.md to Cursor format.
   * Cursor supports SKILL.md in .cursor/skills/ directory.
   */
  convertSkill(skill) {
    const frontmatter = buildFrontmatter({
      name: skill.name,
      description: cleanDescription(skill.description),
    });

    const body = stripClaudeSpecificRefs(skill.content, {
      skillsPath: '.cursor/skills/',
      platformName: 'AI Agent',
      instructionFile: '.cursorrules',
    });

    return {
      path: path.join(this.skillsDir, skill.dirName, 'SKILL.md'),
      content: `${frontmatter}\n${body}`,
    };
  }

  /**
   * Convert an agent definition to a Cursor mode entry.
   * Returns a mode object for inclusion in .cursor/modes.json.
   */
  convertAgent(agent) {
    const prompt = stripAgentTeamsRefs(agent.content, { envLabel: '(platform agent configuration)' });

    const mode = {
      name: agent.name,
      customPrompt: prompt.trim(),
      tools: inferToolsFromAgent(agent),
    };

    return {
      path: `_mode_${agent.name}`,
      content: JSON.stringify(mode),
      mode,
    };
  }

  /**
   * Convert a command to a Cursor custom prompt.
   * Cursor does not fully support slash commands, so these become prompt templates.
   */
  convertCommand(command) {
    return {
      path: path.join('.cursor', 'prompts', `${command.name}.md`),
      content: command.content,
    };
  }

  /**
   * Generate .cursor/modes.json from converted agent modes.
   * @param {Array<{ mode: object }>} modeEntries - Converted agent mode entries
   * @returns {{ path: string, content: string }}
   */
  generateModesJson(modeEntries) {
    const modes = modeEntries
      .filter((e) => e.mode)
      .map((e) => e.mode);

    const modesConfig = { modes };

    return {
      path: '.cursor/modes.json',
      content: JSON.stringify(modesConfig, null, 2) + '\n',
    };
  }

  /**
   * Generate manifest is not applicable for Cursor (no plugin manifest).
   * Returns the .cursorrules file instead.
   */
  generateManifest() {
    const rules = [
      '# Artibot - AI Agent Teams Orchestration',
      `# Version: ${this.config.version ?? '1.1.0'}`,
      '',
      '## Core Principles',
      '- Evidence > assumptions | Code > documentation | Efficiency > verbosity',
      '- Immutability: Always create new objects, never mutate',
      '- Many small files > few large files (200-400 lines typical)',
      '- Test-driven development with 80%+ coverage',
      '',
      '## Coding Standards',
      '- Functions < 50 lines, files < 800 lines',
      '- No deep nesting (> 4 levels)',
      '- Proper error handling on all operations',
      '- Input validation on all external data',
      '',
      '## Project Structure',
      '- agents/ - Agent definitions',
      '- skills/ - SKILL.md format skills',
      '- commands/ - Command definitions',
      '- lib/ - Core modules (ESM, zero dependencies)',
      '',
    ].join('\n');

    return {
      path: '.cursorrules',
      content: rules,
    };
  }
}

/**
 * Infer Cursor tools from agent content.
 * Maps mentioned capabilities to Cursor tool names.
 */
function inferToolsFromAgent(agent) {
  const tools = ['read', 'edit'];
  const content = agent.content.toLowerCase();

  if (content.includes('terminal') || content.includes('bash') || content.includes('command')) {
    tools.push('terminal');
  }
  if (content.includes('search') || content.includes('grep') || content.includes('find')) {
    tools.push('search');
  }
  if (content.includes('web') || content.includes('fetch') || content.includes('url')) {
    tools.push('web');
  }
  if (content.includes('mcp')) {
    tools.push('mcp');
  }

  return [...new Set(tools)];
}
