/**
 * OpenAI Codex CLI adapter.
 * Converts Artibot skills/agents/commands to Codex CLI format.
 *
 * Codex CLI compatibility score: 8/10 (SKILL.md format originated here).
 * - plugin.json -> agents/openai.yaml metadata
 * - CLAUDE.md -> AGENTS.md (instruction chain)
 * - skills/ -> .agents/skills/ (SKILL.md directly compatible)
 * - agents/*.md -> consolidated AGENTS.md sections
 * - commands/ -> SKILL.md-based workflows
 *
 * @module lib/adapters/codex-adapter
 */

import path from 'node:path';
import { BaseAdapter } from './base-adapter.js';

export class CodexAdapter extends BaseAdapter {
  get platformId() {
    return 'codex-cli';
  }

  get platformName() {
    return 'OpenAI Codex CLI';
  }

  get instructionFileName() {
    return 'AGENTS.md';
  }

  get skillsDir() {
    return '.agents/skills';
  }

  /**
   * Convert a SKILL.md to Codex CLI format.
   * Codex CLI natively supports SKILL.md with YAML frontmatter.
   * The format is a passthrough with platform-specific reference updates.
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
   * Convert an agent definition to a section in AGENTS.md.
   * Codex CLI consolidates agent instructions into a single AGENTS.md file.
   * Returns a content block to be concatenated into the final AGENTS.md.
   */
  convertAgent(agent) {
    const content = stripAgentTeamsRefs(agent.content);
    return {
      path: `_agents_section_${agent.name}`,
      content: `\n## Agent: ${agent.role || agent.name}\n\n${content}\n`,
    };
  }

  /**
   * Convert a command to a SKILL.md-based workflow.
   * Codex CLI does not have slash commands, so commands become skill workflows.
   */
  convertCommand(command) {
    const frontmatter = buildFrontmatter({
      name: `cmd-${command.name}`,
      description: `Workflow for /${command.name} command`,
    });

    return {
      path: path.join(this.skillsDir, `cmd-${command.name}`, 'SKILL.md'),
      content: `${frontmatter}\n${command.content}`,
    };
  }

  /**
   * Generate agents/openai.yaml metadata from artibot.config.json.
   */
  generateManifest() {
    const yaml = [
      '# Artibot - AI Agent Teams Orchestration for Codex CLI',
      `# Auto-generated from artibot.config.json v${this.config.version ?? '1.1.0'}`,
      '',
      'name: artibot',
      `version: "${this.config.version ?? '1.1.0'}"`,
      'description: "AI Agent Teams Orchestration Plugin"',
      '',
      'skills:',
      `  directory: "${this.skillsDir}"`,
      '  format: "SKILL.md"',
      '',
      'agents:',
    ];

    const agents = this.config.agents?.taskBased ?? {};
    for (const [task, agentName] of Object.entries(agents)) {
      yaml.push(`  - name: "${agentName}"`);
      yaml.push(`    task: "${task}"`);
    }

    return {
      path: 'agents/openai.yaml',
      content: yaml.join('\n') + '\n',
    };
  }

  /**
   * Generate the consolidated AGENTS.md from all agent sections.
   * @param {Array<{ path: string, content: string }>} agentSections
   * @returns {{ path: string, content: string }}
   */
  generateAgentsMd(agentSections) {
    const header = [
      '# Artibot Agent Instructions',
      '',
      '> Auto-generated from Artibot agent definitions.',
      `> Version: ${this.config.version ?? '1.1.0'}`,
      '',
      '---',
      '',
    ].join('\n');

    const body = agentSections
      .filter((s) => s.path.startsWith('_agents_section_'))
      .map((s) => s.content)
      .join('\n---\n');

    return {
      path: 'AGENTS.md',
      content: header + body,
    };
  }
}

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

function cleanDescription(desc) {
  if (!desc) return '';
  return desc
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

function stripClaudeSpecificRefs(content) {
  return content
    .replace(/\.claude\/skills\//g, '.agents/skills/')
    .replace(/Claude Code/g, 'AI Agent')
    .replace(/CLAUDE\.md/g, 'AGENTS.md');
}

function stripAgentTeamsRefs(content) {
  return content
    .replace(/TeamCreate|TeamDelete/g, '(team coordination)')
    .replace(/SendMessage\(type: "(?:broadcast|shutdown_request|shutdown_response|plan_approval_response)"\)/g, '(agent communication)')
    .replace(/CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/g, '(platform agent configuration)')
    .replace(/Claude Code/g, 'AI Agent Platform');
}
