/**
 * Google Antigravity IDE adapter.
 * Converts Artibot skills/agents/commands to Antigravity format.
 *
 * Antigravity compatibility score: 8/10 (shares Gemini CLI ecosystem).
 * - CLAUDE.md -> ~/.gemini/GEMINI.md + .antigravity/rules.md
 * - agents/*.md -> .antigravity/agents/*.md (Markdown-based, like Gemini CLI)
 * - skills/ -> .antigravity/skills/ (SKILL.md directly compatible)
 * - commands/ -> .antigravity/workflows/ (workflow prompts)
 * - hooks -> Agent Manager artifact hooks
 *
 * Key differences from Gemini CLI:
 * - Uses .antigravity/ directory for project config (not .gemini/)
 * - Shares ~/.gemini/GEMINI.md for global rules
 * - Also reads .cursorrules (Cursor compatibility)
 * - Agent Manager provides visual parallel orchestration
 * - Supports multiple AI models (Gemini 3 Pro, Claude, GPT)
 *
 * Sub-agent capabilities:
 * - Parallel: Multiple agents across workspaces via Agent Manager
 * - Async: Agents work independently, notify on completion
 * - Artifacts: Agents produce verifiable deliverables (diffs, screenshots, tests)
 *
 * @module lib/adapters/antigravity-adapter
 */

import path from 'node:path';
import { BaseAdapter } from './base-adapter.js';
import { buildFrontmatter, cleanDescription } from './adapter-utils.js';

export class AntigravityAdapter extends BaseAdapter {
  get platformId() {
    return 'antigravity';
  }

  get platformName() {
    return 'Google Antigravity';
  }

  get instructionFileName() {
    return '.antigravity/rules.md';
  }

  get skillsDir() {
    return '.antigravity/skills';
  }

  /**
   * Convert a SKILL.md to Antigravity format.
   * Antigravity supports SKILL.md natively via its Gemini CLI heritage.
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
   * Convert an agent definition to Antigravity agent format.
   * Antigravity uses Markdown-based agent definitions similar to Gemini CLI.
   * Agent Teams API references are converted to Agent Manager instructions.
   */
  convertAgent(agent) {
    const content = convertToAgentManager(agent.content);
    return {
      path: path.join('.antigravity', 'agents', `${agent.name}.md`),
      content,
    };
  }

  /**
   * Convert a command to an Antigravity workflow prompt.
   */
  convertCommand(command) {
    return {
      path: path.join('.antigravity', 'workflows', `${command.name}.md`),
      content: command.content,
    };
  }

  /**
   * Generate the .antigravity/rules.md and .cursorrules files.
   */
  generateManifest() {
    const rules = [
      '# Artibot - AI Agent Teams Orchestration',
      `# Version: ${this.config.version ?? '1.1.0'}`,
      '# Platform: Google Antigravity',
      '',
      '## Orchestration Mode',
      '',
      'Use the Agent Manager to spawn and orchestrate parallel agents.',
      'Each agent works independently across workspaces with async execution.',
      '',
      '### Available Agents',
      '',
    ];

    const agents = this.config.agents?.taskBased ?? {};
    for (const [task, agentName] of Object.entries(agents)) {
      rules.push(`- **${agentName}**: ${task}`);
    }

    rules.push(
      '',
      '## Core Principles',
      '- Evidence > assumptions | Code > documentation | Efficiency > verbosity',
      '- Immutability: Always create new objects, never mutate',
      '- Many small files > few large files (200-400 lines typical)',
      '- Test-driven development with 80%+ coverage',
      '',
      '## Delegation Strategy',
      '',
      'For complex tasks requiring 3+ steps or multiple domains:',
      '1. Spawn specialized agents via Agent Manager',
      '2. Each agent works in its own workspace (parallel execution)',
      '3. Agents produce Artifacts (diffs, test results, screenshots)',
      '4. Review and merge Artifacts when agents complete',
      '5. Use feedback on Artifacts to steer agent behavior',
      '',
    );

    return {
      path: '.antigravity/rules.md',
      content: rules.join('\n'),
    };
  }
}

function stripClaudeSpecificRefs(content) {
  return content
    .replace(/\.claude\/skills\//g, '.antigravity/skills/')
    .replace(/Claude Code/g, 'AI Agent')
    .replace(/CLAUDE\.md/g, '.antigravity/rules.md');
}

/**
 * Convert Agent Teams API references to Agent Manager instructions.
 * Maps Claude-specific team tools to Antigravity's Agent Manager paradigm.
 */
function convertToAgentManager(content) {
  return content
    .replace(/TeamCreate\([^)]*\)/g, 'Spawn agents via Agent Manager')
    .replace(/TeamDelete\([^)]*\)/g, 'Close agent workspaces when done')
    .replace(/SendMessage\(type:\s*"message"[^)]*\)/g, 'Leave feedback on agent Artifact')
    .replace(/SendMessage\(type:\s*"broadcast"[^)]*\)/g, 'Update all agent workspaces')
    .replace(/SendMessage\(type:\s*"shutdown_request"[^)]*\)/g, 'Close agent workspace')
    .replace(/TaskCreate\([^)]*\)/g, 'Create task in Agent Manager')
    .replace(/TaskList\(\)/g, 'Review Agent Manager task board')
    .replace(/TaskGet\([^)]*\)/g, 'Review agent Artifact')
    .replace(/TaskUpdate\([^)]*\)/g, 'Update task status')
    .replace(/TeamCreate|TeamDelete/g, '(Agent Manager)')
    .replace(/SendMessage/g, '(Agent feedback)')
    .replace(/CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/g, '(Antigravity Agent Manager)')
    .replace(/Claude Code/g, 'Google Antigravity');
}
