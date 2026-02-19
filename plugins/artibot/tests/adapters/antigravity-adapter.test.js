import { describe, it, expect, beforeEach } from 'vitest';
import { AntigravityAdapter } from '../../lib/adapters/antigravity-adapter.js';
import { BaseAdapter } from '../../lib/adapters/base-adapter.js';

describe('AntigravityAdapter', () => {
  /** @type {AntigravityAdapter} */
  let adapter;

  const defaultConfig = {
    version: '1.3.0',
    agents: {
      taskBased: {
        frontend: 'frontend-developer',
        backend: 'backend-developer',
        security: 'security-reviewer',
      },
    },
  };

  beforeEach(() => {
    adapter = new AntigravityAdapter({ pluginRoot: '/project/root', config: defaultConfig });
  });

  describe('inheritance and identity', () => {
    it('extends BaseAdapter', () => {
      expect(adapter).toBeInstanceOf(BaseAdapter);
    });

    it('returns "antigravity" as platformId', () => {
      expect(adapter.platformId).toBe('antigravity');
    });

    it('returns "Google Antigravity" as platformName', () => {
      expect(adapter.platformName).toBe('Google Antigravity');
    });

    it('returns ".antigravity/rules.md" as instructionFileName', () => {
      expect(adapter.instructionFileName).toBe('.antigravity/rules.md');
    });

    it('returns ".antigravity/skills" as skillsDir', () => {
      expect(adapter.skillsDir).toBe('.antigravity/skills');
    });

    it('stores pluginRoot and config from constructor', () => {
      expect(adapter.pluginRoot).toBe('/project/root');
      expect(adapter.config).toBe(defaultConfig);
    });
  });

  describe('convertSkill()', () => {
    const baseSkill = {
      name: 'persona-frontend',
      description: 'Frontend UX specialist',
      dirName: 'persona-frontend',
      content: 'Use Claude Code with .claude/skills/ and read CLAUDE.md for guidelines.',
    };

    it('returns path under .antigravity/skills with dirName and SKILL.md', () => {
      const result = adapter.convertSkill(baseSkill);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.antigravity/skills/persona-frontend/SKILL.md');
    });

    it('includes YAML frontmatter with name and description', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).toMatch(/^---/);
      expect(result.content).toContain('name: persona-frontend');
      expect(result.content).toContain('description: Frontend UX specialist');
    });

    it('replaces .claude/skills/ with .antigravity/skills/', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).not.toContain('.claude/skills/');
      expect(result.content).toContain('.antigravity/skills/');
    });

    it('replaces "Claude Code" with "AI Agent"', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).not.toContain('Claude Code');
      expect(result.content).toContain('AI Agent');
    });

    it('replaces "CLAUDE.md" with ".antigravity/rules.md"', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).not.toContain('CLAUDE.md');
      expect(result.content).toContain('.antigravity/rules.md');
    });

    it('handles empty description gracefully', () => {
      const skill = { ...baseSkill, description: '' };
      const result = adapter.convertSkill(skill);
      expect(result.content).toContain('description:');
    });

    it('handles null description gracefully', () => {
      const skill = { ...baseSkill, description: null };
      const result = adapter.convertSkill(skill);
      expect(result.content).toContain('description:');
    });

    it('handles multiline description with YAML block scalar', () => {
      const skill = { ...baseSkill, description: 'Line A\nLine B' };
      const result = adapter.convertSkill(skill);
      expect(result.content).toContain('description: |');
      expect(result.content).toContain('  Line A');
      expect(result.content).toContain('  Line B');
    });
  });

  describe('convertAgent()', () => {
    it('returns path under .antigravity/agents/ with agent name', () => {
      const agent = { name: 'frontend', content: 'Frontend agent instructions' };
      const result = adapter.convertAgent(agent);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.antigravity/agents/frontend.md');
    });

    it('preserves agent content after conversion', () => {
      const agent = { name: 'test', content: 'Simple agent content without API references' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('Simple agent content');
    });
  });

  describe('convertAgent() - convertToAgentManager transformations', () => {
    it('converts TeamCreate(...) to Agent Manager spawn instruction', () => {
      const agent = { name: 'test', content: 'Use TeamCreate(team_id: "squad") to form teams' };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('TeamCreate(');
      expect(result.content).toContain('Spawn agents via Agent Manager');
    });

    it('converts TeamDelete(...) to workspace close instruction', () => {
      const agent = { name: 'test', content: 'Call TeamDelete(team_id: "squad") when done' };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('TeamDelete(');
      expect(result.content).toContain('Close agent workspaces when done');
    });

    it('converts SendMessage(type: "message"...) to feedback instruction', () => {
      const agent = { name: 'test', content: 'SendMessage(type: "message", target: "agent1") for review' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('Leave feedback on agent Artifact');
    });

    it('converts SendMessage(type: "broadcast"...) to workspace update', () => {
      const agent = { name: 'test', content: 'SendMessage(type: "broadcast", msg: "update") to all' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('Update all agent workspaces');
    });

    it('converts SendMessage(type: "shutdown_request"...) to close workspace', () => {
      const agent = { name: 'test', content: 'SendMessage(type: "shutdown_request", target: "agent1")' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('Close agent workspace');
    });

    it('converts TaskCreate(...) to Agent Manager task creation', () => {
      const agent = { name: 'test', content: 'TaskCreate(title: "review code")' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('Create task in Agent Manager');
    });

    it('converts TaskList() to task board review', () => {
      const agent = { name: 'test', content: 'Check TaskList() for pending items' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('Review Agent Manager task board');
    });

    it('converts TaskGet(...) to artifact review', () => {
      const agent = { name: 'test', content: 'TaskGet(task_id: "123") for status' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('Review agent Artifact');
    });

    it('converts TaskUpdate(...) to status update', () => {
      const agent = { name: 'test', content: 'TaskUpdate(task_id: "123", status: "done")' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('Update task status');
    });

    it('converts bare TeamCreate/TeamDelete to (Agent Manager)', () => {
      const agent = { name: 'test', content: 'TeamCreate and TeamDelete are core operations' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('(Agent Manager)');
    });

    it('converts bare SendMessage to (Agent feedback)', () => {
      const agent = { name: 'test', content: 'Use SendMessage for communication' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('(Agent feedback)');
    });

    it('converts CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS to Antigravity reference', () => {
      const agent = { name: 'test', content: 'Set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1' };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
      expect(result.content).toContain('(Antigravity Agent Manager)');
    });

    it('replaces "Claude Code" with "Google Antigravity"', () => {
      const agent = { name: 'test', content: 'Claude Code is the platform engine' };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('Claude Code');
      expect(result.content).toContain('Google Antigravity');
    });

    it('handles content with multiple API references combined', () => {
      const agent = {
        name: 'orchestrator',
        content: [
          'Use TeamCreate(team_id: "squad") to form the team.',
          'SendMessage(type: "broadcast", msg: "start") to notify.',
          'Check TaskList() for progress.',
          'TeamDelete(team_id: "squad") when complete.',
          'Requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.',
          'Claude Code provides the orchestration layer.',
        ].join('\n'),
      };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('Spawn agents via Agent Manager');
      expect(result.content).toContain('Update all agent workspaces');
      expect(result.content).toContain('Review Agent Manager task board');
      expect(result.content).toContain('Close agent workspaces when done');
      expect(result.content).toContain('(Antigravity Agent Manager)');
      expect(result.content).toContain('Google Antigravity');
      expect(result.content).not.toContain('Claude Code');
      expect(result.content).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
    });
  });

  describe('convertCommand()', () => {
    const baseCommand = { name: 'build', content: '## Build\n\nBuilds the project.' };

    it('returns path under .antigravity/workflows/ with command name', () => {
      const result = adapter.convertCommand(baseCommand);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.antigravity/workflows/build.md');
    });

    it('preserves original command content as-is', () => {
      const result = adapter.convertCommand(baseCommand);
      expect(result.content).toBe(baseCommand.content);
    });
  });

  describe('generateManifest()', () => {
    it('returns path as .antigravity/rules.md', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.path).toBe('.antigravity/rules.md');
    });

    it('includes version from config', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('Version: 1.3.0');
    });

    it('defaults version to 1.1.0 when not in config', () => {
      const noVersionAdapter = new AntigravityAdapter({ pluginRoot: '/root', config: {} });
      const manifest = noVersionAdapter.generateManifest();
      expect(manifest.content).toContain('Version: 1.1.0');
    });

    it('includes platform header', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('# Platform: Google Antigravity');
    });

    it('includes orchestration mode section', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('## Orchestration Mode');
      expect(manifest.content).toContain('Agent Manager');
    });

    it('lists agents from config.agents.taskBased', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('**frontend-developer**: frontend');
      expect(manifest.content).toContain('**backend-developer**: backend');
      expect(manifest.content).toContain('**security-reviewer**: security');
    });

    it('handles empty agents config gracefully', () => {
      const emptyAdapter = new AntigravityAdapter({ pluginRoot: '/root', config: { version: '1.0.0' } });
      const manifest = emptyAdapter.generateManifest();
      expect(manifest.content).toContain('### Available Agents');
      // No agent list entries
      expect(manifest.content).not.toContain('**frontend-developer**');
    });

    it('includes core principles section', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('## Core Principles');
      expect(manifest.content).toContain('Evidence > assumptions');
    });

    it('includes delegation strategy section', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('## Delegation Strategy');
      expect(manifest.content).toContain('Spawn specialized agents');
      expect(manifest.content).toContain('Artifacts');
    });
  });

  describe('validate()', () => {
    it('passes valid result with platform and files', () => {
      const result = {
        platform: 'antigravity',
        files: [{ path: '.antigravity/rules.md', content: '# Rules\n' }],
        warnings: [],
      };
      const { valid, errors } = adapter.validate(result);
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    });

    it('fails when platform is missing', () => {
      const result = { files: [{ path: 'f', content: '' }], warnings: [] };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(false);
    });

    it('fails when files array is empty', () => {
      const result = { platform: 'antigravity', files: [], warnings: [] };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(false);
    });

    it('fails when file content is not a string', () => {
      const result = {
        platform: 'antigravity',
        files: [{ path: 'test.md', content: { key: 'value' } }],
        warnings: [],
      };
      const { valid, errors } = adapter.validate(result);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('content must be a string'))).toBe(true);
    });

    it('validates properly generated output end-to-end', () => {
      const manifest = adapter.generateManifest();
      const skill = adapter.convertSkill({
        name: 'test',
        description: 'Test skill',
        dirName: 'test',
        content: 'Test content',
      });
      const result = {
        platform: adapter.platformId,
        files: [manifest, skill],
        warnings: [],
      };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(true);
    });
  });
});
