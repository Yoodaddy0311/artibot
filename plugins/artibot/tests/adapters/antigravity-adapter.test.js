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

    it('passes through content with no Claude-specific refs unchanged', () => {
      const skill = { ...baseSkill, content: 'Pure generic content only.' };
      const result = adapter.convertSkill(skill);
      expect(result.content).toContain('Pure generic content only.');
    });

    it('replaces multiple .claude/skills/ occurrences', () => {
      const skill = {
        ...baseSkill,
        content: 'See .claude/skills/a and .claude/skills/b.',
      };
      const result = adapter.convertSkill(skill);
      expect(result.content).not.toContain('.claude/skills/');
      expect(result.content).toContain('.antigravity/skills/a');
      expect(result.content).toContain('.antigravity/skills/b');
    });

    it('handles description with trailing whitespace trimmed', () => {
      const skill = { ...baseSkill, description: 'Trimmed desc   ' };
      const result = adapter.convertSkill(skill);
      expect(result.content).toContain('Trimmed desc');
      expect(result.content).not.toContain('Trimmed desc   ');
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

    it('returns content as a string', () => {
      const agent = { name: 'test', content: 'Some content' };
      const result = adapter.convertAgent(agent);
      expect(typeof result.content).toBe('string');
    });

    it('handles agent with empty content', () => {
      const agent = { name: 'empty', content: '' };
      const result = adapter.convertAgent(agent);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.antigravity/agents/empty.md');
      expect(result.content).toBe('');
    });

    it('handles agent name with hyphens in path', () => {
      const agent = { name: 'senior-architect', content: 'Senior architect content' };
      const result = adapter.convertAgent(agent);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.antigravity/agents/senior-architect.md');
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

    it('handles content with no API references - returns content unchanged', () => {
      const plain = 'No API references here. Just plain text instructions.';
      const agent = { name: 'plain', content: plain };
      const result = adapter.convertAgent(agent);
      expect(result.content).toBe(plain);
    });

    it('handles multiple TaskCreate calls in content', () => {
      const agent = {
        name: 'test',
        content: 'TaskCreate(title: "task1") and TaskCreate(title: "task2")',
      };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('TaskCreate(');
      // Both should be converted
      const count = (result.content.match(/Create task in Agent Manager/g) || []).length;
      expect(count).toBe(2);
    });

    it('handles multiple TaskGet calls in content', () => {
      const agent = {
        name: 'test',
        content: 'TaskGet(task_id: "1") and TaskGet(task_id: "2")',
      };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('TaskGet(');
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

    it('replacements are applied in order without cross-contamination', () => {
      // TeamCreate(...) should match specific regex first, then bare TeamCreate
      const agent = {
        name: 'test',
        content: 'TeamCreate(id: "t1") is first, then bare TeamCreate reference.',
      };
      const result = adapter.convertAgent(agent);
      // The specific match converts to "Spawn agents via Agent Manager"
      expect(result.content).toContain('Spawn agents via Agent Manager');
      // Any remaining bare "TeamCreate" becomes "(Agent Manager)"
      expect(result.content).not.toContain('TeamCreate');
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

    it('handles command names with hyphens', () => {
      const command = { name: 'run-tests', content: 'Run the test suite.' };
      const result = adapter.convertCommand(command);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.antigravity/workflows/run-tests.md');
    });

    it('handles command with empty content', () => {
      const command = { name: 'noop', content: '' };
      const result = adapter.convertCommand(command);
      expect(result.content).toBe('');
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.antigravity/workflows/noop.md');
    });

    it('handles command with multiline content', () => {
      const command = {
        name: 'deploy',
        content: '## Deploy\n\nStep 1: Build\nStep 2: Test\nStep 3: Ship',
      };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('Step 1: Build');
      expect(result.content).toContain('Step 3: Ship');
    });

    it('does not transform content (passthrough)', () => {
      // Unlike convertAgent, convertCommand is a pure passthrough
      const command = {
        name: 'test',
        content: 'Claude Code specific content should NOT be changed here.',
      };
      const result = adapter.convertCommand(command);
      expect(result.content).toBe(command.content);
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

    it('defaults version to 1.1.0 when config has agents but no version', () => {
      const agentsNoVersionAdapter = new AntigravityAdapter({
        pluginRoot: '/root',
        config: { agents: { taskBased: { qa: 'qa-engineer' } } },
      });
      const manifest = agentsNoVersionAdapter.generateManifest();
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

    it('handles null agents config gracefully', () => {
      const nullAgentsAdapter = new AntigravityAdapter({
        pluginRoot: '/root',
        config: { version: '1.0.0', agents: null },
      });
      const manifest = nullAgentsAdapter.generateManifest();
      expect(manifest.content).toContain('### Available Agents');
      expect(manifest.content).not.toContain('**frontend-developer**');
    });

    it('handles config with agents but no taskBased key', () => {
      const noTaskBasedAdapter = new AntigravityAdapter({
        pluginRoot: '/root',
        config: { version: '2.0.0', agents: { patterns: ['swarm'] } },
      });
      const manifest = noTaskBasedAdapter.generateManifest();
      expect(manifest.content).toContain('Version: 2.0.0');
      expect(manifest.content).not.toContain('**');
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

    it('includes async execution detail in orchestration mode', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('async execution');
    });

    it('includes artifact-based workflow in delegation strategy', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('Artifacts (diffs, test results, screenshots)');
    });

    it('includes five-step delegation process', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('1. Spawn specialized agents');
      expect(manifest.content).toContain('5. Use feedback');
    });

    it('content is a non-empty string', () => {
      const manifest = adapter.generateManifest();
      expect(typeof manifest.content).toBe('string');
      expect(manifest.content.length).toBeGreaterThan(0);
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

    it('fails when file is missing path', () => {
      const result = {
        platform: 'antigravity',
        files: [{ content: 'content without path' }],
        warnings: [],
      };
      const { valid, errors } = adapter.validate(result);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('missing path'))).toBe(true);
    });

    it('validates properly generated manifest output end-to-end', () => {
      const manifest = adapter.generateManifest();
      const result = {
        platform: adapter.platformId,
        files: [manifest],
        warnings: [],
      };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(true);
    });

    it('validates properly generated skill output end-to-end', () => {
      const skill = adapter.convertSkill({
        name: 'test',
        description: 'Test skill',
        dirName: 'test',
        content: 'Test content',
      });
      const result = {
        platform: adapter.platformId,
        files: [skill],
        warnings: [],
      };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(true);
    });

    it('validates properly generated command output end-to-end', () => {
      const cmd = adapter.convertCommand({ name: 'analyze', content: '## Analyze' });
      const result = {
        platform: adapter.platformId,
        files: [cmd],
        warnings: [],
      };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(true);
    });

    it('validates properly generated agent output end-to-end', () => {
      const agent = adapter.convertAgent({
        name: 'architect',
        content: 'Architect agent for system design.',
      });
      const result = {
        platform: adapter.platformId,
        files: [agent],
        warnings: [],
      };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(true);
    });

    it('validates combined output end-to-end', () => {
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
