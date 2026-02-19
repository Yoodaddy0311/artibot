import { describe, it, expect, beforeEach } from 'vitest';
import { CodexAdapter } from '../../lib/adapters/codex-adapter.js';
import { BaseAdapter } from '../../lib/adapters/base-adapter.js';

describe('CodexAdapter', () => {
  /** @type {CodexAdapter} */
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
    adapter = new CodexAdapter({ pluginRoot: '/project/root', config: defaultConfig });
  });

  describe('inheritance and identity', () => {
    it('extends BaseAdapter', () => {
      expect(adapter).toBeInstanceOf(BaseAdapter);
    });

    it('returns "codex-cli" as platformId', () => {
      expect(adapter.platformId).toBe('codex-cli');
    });

    it('returns "OpenAI Codex CLI" as platformName', () => {
      expect(adapter.platformName).toBe('OpenAI Codex CLI');
    });

    it('returns "AGENTS.md" as instructionFileName', () => {
      expect(adapter.instructionFileName).toBe('AGENTS.md');
    });

    it('returns ".agents/skills" as skillsDir', () => {
      expect(adapter.skillsDir).toBe('.agents/skills');
    });

    it('stores pluginRoot and config from constructor', () => {
      expect(adapter.pluginRoot).toBe('/project/root');
      expect(adapter.config).toBe(defaultConfig);
    });
  });

  describe('convertSkill()', () => {
    const baseSkill = {
      name: 'persona-architect',
      description: 'Systems architecture specialist',
      dirName: 'persona-architect',
      content: 'Use Claude Code with .claude/skills/ and read CLAUDE.md for instructions.',
    };

    it('returns path under skillsDir with dirName and SKILL.md', () => {
      const result = adapter.convertSkill(baseSkill);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.agents/skills/persona-architect/SKILL.md');
    });

    it('includes YAML frontmatter with name and description', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).toMatch(/^---/);
      expect(result.content).toContain('name: persona-architect');
      expect(result.content).toContain('description: Systems architecture specialist');
      expect(result.content).toMatch(/---\n/);
    });

    it('replaces .claude/skills/ with .agents/skills/', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).not.toContain('.claude/skills/');
      expect(result.content).toContain('.agents/skills/');
    });

    it('replaces "Claude Code" with "AI Agent"', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).not.toContain('Claude Code');
      expect(result.content).toContain('AI Agent');
    });

    it('replaces "CLAUDE.md" with "AGENTS.md"', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).not.toContain('CLAUDE.md');
      expect(result.content).toContain('AGENTS.md');
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

    it('handles multiline description in frontmatter', () => {
      const skill = { ...baseSkill, description: 'Line one\nLine two' };
      const result = adapter.convertSkill(skill);
      expect(result.content).toContain('description: |');
      expect(result.content).toContain('  Line one');
      expect(result.content).toContain('  Line two');
    });
  });

  describe('convertAgent()', () => {
    it('returns path as _agents_section_ prefix with agent name', () => {
      const agent = { name: 'frontend', content: 'Frontend agent content', role: 'Frontend Developer' };
      const result = adapter.convertAgent(agent);
      expect(result.path).toBe('_agents_section_frontend');
    });

    it('includes role in the heading when role is provided', () => {
      const agent = { name: 'architect', content: 'Architect content', role: 'Systems Architect' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('## Agent: Systems Architect');
    });

    it('falls back to name when role is not provided', () => {
      const agent = { name: 'devops', content: 'DevOps content' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('## Agent: devops');
    });

    it('strips TeamCreate and TeamDelete references', () => {
      const agent = { name: 'test', content: 'Uses TeamCreate and TeamDelete for teams' };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('TeamCreate');
      expect(result.content).not.toContain('TeamDelete');
      expect(result.content).toContain('(team coordination)');
    });

    it('strips CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS reference', () => {
      const agent = { name: 'test', content: 'Requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1' };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
      expect(result.content).toContain('(platform agent configuration)');
    });

    it('strips SendMessage broadcast references', () => {
      const agent = { name: 'test', content: 'SendMessage(type: "broadcast") to all agents' };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('SendMessage(type: "broadcast")');
      expect(result.content).toContain('(agent communication)');
    });

    it('replaces "Claude Code" with "AI Agent Platform"', () => {
      const agent = { name: 'test', content: 'Claude Code is the platform' };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('Claude Code');
      expect(result.content).toContain('AI Agent Platform');
    });
  });

  describe('convertCommand()', () => {
    const baseCommand = { name: 'build', content: '## Build\n\nBuilds the project.' };

    it('returns path under skillsDir with cmd- prefix and SKILL.md', () => {
      const result = adapter.convertCommand(baseCommand);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.agents/skills/cmd-build/SKILL.md');
    });

    it('includes frontmatter with cmd- prefixed name', () => {
      const result = adapter.convertCommand(baseCommand);
      expect(result.content).toContain('name: cmd-build');
    });

    it('includes description referencing original command', () => {
      const result = adapter.convertCommand(baseCommand);
      expect(result.content).toContain('Workflow for /build command');
    });

    it('preserves original command content in body', () => {
      const result = adapter.convertCommand(baseCommand);
      expect(result.content).toContain('## Build');
      expect(result.content).toContain('Builds the project.');
    });
  });

  describe('generateManifest()', () => {
    it('returns path as agents/openai.yaml', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.path).toBe('agents/openai.yaml');
    });

    it('includes version from config', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('version: "1.3.0"');
    });

    it('defaults version to 1.1.0 when not in config', () => {
      const noVersionAdapter = new CodexAdapter({ pluginRoot: '/root', config: {} });
      const manifest = noVersionAdapter.generateManifest();
      expect(manifest.content).toContain('version: "1.1.0"');
    });

    it('includes skills directory and format', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('directory: ".agents/skills"');
      expect(manifest.content).toContain('format: "SKILL.md"');
    });

    it('lists agents from config.agents.taskBased', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('name: "frontend-developer"');
      expect(manifest.content).toContain('task: "frontend"');
      expect(manifest.content).toContain('name: "backend-developer"');
      expect(manifest.content).toContain('task: "backend"');
    });

    it('handles empty agents config gracefully', () => {
      const emptyAdapter = new CodexAdapter({ pluginRoot: '/root', config: { version: '1.0.0' } });
      const manifest = emptyAdapter.generateManifest();
      expect(manifest.content).toContain('agents:');
      expect(manifest.content).not.toContain('name: "');
    });

    it('content ends with newline', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content.endsWith('\n')).toBe(true);
    });
  });

  describe('generateAgentsMd()', () => {
    it('generates AGENTS.md from agent sections', () => {
      const sections = [
        { path: '_agents_section_frontend', content: '\n## Agent: Frontend\n\nFrontend content\n' },
        { path: '_agents_section_backend', content: '\n## Agent: Backend\n\nBackend content\n' },
      ];
      const result = adapter.generateAgentsMd(sections);
      expect(result.path).toBe('AGENTS.md');
      expect(result.content).toContain('# Artibot Agent Instructions');
      expect(result.content).toContain('## Agent: Frontend');
      expect(result.content).toContain('## Agent: Backend');
    });

    it('includes version from config', () => {
      const result = adapter.generateAgentsMd([]);
      expect(result.content).toContain('Version: 1.3.0');
    });

    it('filters out non-agent section entries', () => {
      const sections = [
        { path: '_agents_section_test', content: '\n## Agent: Test\n\nTest\n' },
        { path: 'some/other/file.md', content: 'Not an agent section' },
      ];
      const result = adapter.generateAgentsMd(sections);
      expect(result.content).toContain('## Agent: Test');
      expect(result.content).not.toContain('Not an agent section');
    });

    it('joins agent sections with horizontal rule separator', () => {
      const sections = [
        { path: '_agents_section_a', content: 'Section A' },
        { path: '_agents_section_b', content: 'Section B' },
      ];
      const result = adapter.generateAgentsMd(sections);
      expect(result.content).toContain('---');
    });
  });

  describe('validate()', () => {
    it('passes valid result with platform and files', () => {
      const result = {
        platform: 'codex-cli',
        files: [{ path: 'agents/openai.yaml', content: 'name: artibot\n' }],
        warnings: [],
      };
      const { valid, errors } = adapter.validate(result);
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    });

    it('fails when platform is missing', () => {
      const result = { files: [{ path: 'f.md', content: '' }], warnings: [] };
      const { valid, errors } = adapter.validate(result);
      expect(valid).toBe(false);
      expect(errors).toContain('Missing platform identifier');
    });

    it('fails when files array is empty', () => {
      const result = { platform: 'codex-cli', files: [], warnings: [] };
      const { valid, errors } = adapter.validate(result);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('No files'))).toBe(true);
    });

    it('fails when file content is not a string', () => {
      const result = {
        platform: 'codex-cli',
        files: [{ path: 'test.md', content: 123 }],
        warnings: [],
      };
      const { valid, errors } = adapter.validate(result);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('content must be a string'))).toBe(true);
    });
  });
});
