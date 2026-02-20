import { describe, it, expect, beforeEach } from 'vitest';
import { CursorAdapter } from '../../lib/adapters/cursor-adapter.js';
import { BaseAdapter } from '../../lib/adapters/base-adapter.js';

describe('CursorAdapter', () => {
  /** @type {CursorAdapter} */
  let adapter;

  const defaultConfig = {
    version: '1.3.0',
    agents: {
      taskBased: {
        frontend: 'frontend-developer',
        backend: 'backend-developer',
      },
    },
  };

  beforeEach(() => {
    adapter = new CursorAdapter({ pluginRoot: '/project/root', config: defaultConfig });
  });

  describe('inheritance and identity', () => {
    it('extends BaseAdapter', () => {
      expect(adapter).toBeInstanceOf(BaseAdapter);
    });

    it('returns "cursor" as platformId', () => {
      expect(adapter.platformId).toBe('cursor');
    });

    it('returns "Cursor IDE" as platformName', () => {
      expect(adapter.platformName).toBe('Cursor IDE');
    });

    it('returns ".cursorrules" as instructionFileName', () => {
      expect(adapter.instructionFileName).toBe('.cursorrules');
    });

    it('returns ".cursor/skills" as skillsDir', () => {
      expect(adapter.skillsDir).toBe('.cursor/skills');
    });

    it('stores pluginRoot and config from constructor', () => {
      expect(adapter.pluginRoot).toBe('/project/root');
      expect(adapter.config).toBe(defaultConfig);
    });
  });

  describe('convertSkill()', () => {
    const baseSkill = {
      name: 'coding-standards',
      description: 'Coding standards enforcement',
      dirName: 'coding-standards',
      content: 'Use Claude Code with .claude/skills/ and read CLAUDE.md for guidance.',
    };

    it('returns path under .cursor/skills with dirName and SKILL.md', () => {
      const result = adapter.convertSkill(baseSkill);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.cursor/skills/coding-standards/SKILL.md');
    });

    it('includes YAML frontmatter with name and description', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).toMatch(/^---/);
      expect(result.content).toContain('name: coding-standards');
      expect(result.content).toContain('description: Coding standards enforcement');
    });

    it('replaces .claude/skills/ with .cursor/skills/', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).not.toContain('.claude/skills/');
      expect(result.content).toContain('.cursor/skills/');
    });

    it('replaces "Claude Code" with "AI Agent"', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).not.toContain('Claude Code');
      expect(result.content).toContain('AI Agent');
    });

    it('replaces "CLAUDE.md" with ".cursorrules"', () => {
      const result = adapter.convertSkill(baseSkill);
      expect(result.content).not.toContain('CLAUDE.md');
      expect(result.content).toContain('.cursorrules');
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
      const skill = { ...baseSkill, description: 'First line\nSecond line' };
      const result = adapter.convertSkill(skill);
      expect(result.content).toContain('description: |');
      expect(result.content).toContain('  First line');
      expect(result.content).toContain('  Second line');
    });

    it('passes through content with no Claude refs unchanged', () => {
      const skill = { ...baseSkill, content: 'Generic content with no platform references.' };
      const result = adapter.convertSkill(skill);
      expect(result.content).toContain('Generic content with no platform references.');
    });

    it('replaces multiple .claude/skills/ occurrences', () => {
      const skill = {
        ...baseSkill,
        content: 'See .claude/skills/foo and .claude/skills/bar.',
      };
      const result = adapter.convertSkill(skill);
      expect(result.content).not.toContain('.claude/skills/');
      expect(result.content).toContain('.cursor/skills/foo');
      expect(result.content).toContain('.cursor/skills/bar');
    });

    it('handles description with trailing whitespace trimmed per line', () => {
      const skill = { ...baseSkill, description: 'Clean description   ' };
      const result = adapter.convertSkill(skill);
      expect(result.content).toContain('Clean description');
      expect(result.content).not.toContain('Clean description   ');
    });
  });

  describe('convertAgent()', () => {
    it('returns path with _mode_ prefix for later modes.json aggregation', () => {
      const agent = { name: 'frontend', content: 'Frontend developer agent' };
      const result = adapter.convertAgent(agent);
      expect(result.path).toBe('_mode_frontend');
    });

    it('returns a mode object with name, customPrompt, and tools', () => {
      const agent = { name: 'architect', content: 'Architect agent content' };
      const result = adapter.convertAgent(agent);
      expect(result.mode).toBeDefined();
      expect(result.mode.name).toBe('architect');
      expect(typeof result.mode.customPrompt).toBe('string');
      expect(Array.isArray(result.mode.tools)).toBe(true);
    });

    it('content is JSON-serialized mode object', () => {
      const agent = { name: 'test', content: 'Simple agent content' };
      const result = adapter.convertAgent(agent);
      const parsed = JSON.parse(result.content);
      expect(parsed.name).toBe('test');
      expect(parsed.customPrompt).toBeDefined();
    });

    it('strips TeamCreate and TeamDelete references from customPrompt', () => {
      const agent = { name: 'test', content: 'TeamCreate and TeamDelete operations' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.customPrompt).not.toContain('TeamCreate');
      expect(result.mode.customPrompt).not.toContain('TeamDelete');
      expect(result.mode.customPrompt).toContain('(team coordination)');
    });

    it('strips CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', () => {
      const agent = { name: 'test', content: 'Requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.customPrompt).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
    });

    it('strips SendMessage references', () => {
      const agent = { name: 'test', content: 'SendMessage(type: "broadcast") to team' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.customPrompt).not.toContain('SendMessage(type: "broadcast")');
    });

    it('strips SendMessage shutdown_request reference', () => {
      const agent = { name: 'test', content: 'SendMessage(type: "shutdown_request") on done' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.customPrompt).not.toContain('SendMessage(type: "shutdown_request")');
      expect(result.mode.customPrompt).toContain('(agent communication)');
    });

    it('replaces "Claude Code" with "AI Agent Platform"', () => {
      const agent = { name: 'test', content: 'Claude Code is the engine' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.customPrompt).not.toContain('Claude Code');
      expect(result.mode.customPrompt).toContain('AI Agent Platform');
    });

    it('customPrompt is trimmed', () => {
      const agent = { name: 'test', content: '  padded content  ' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.customPrompt).toBe(result.mode.customPrompt.trim());
    });

    it('handles agent with empty content', () => {
      const agent = { name: 'empty', content: '' };
      const result = adapter.convertAgent(agent);
      expect(result.path).toBe('_mode_empty');
      expect(result.mode.name).toBe('empty');
      expect(result.mode.customPrompt).toBe('');
    });
  });

  describe('convertAgent() tool inference', () => {
    it('always includes "read" and "edit" as base tools', () => {
      const agent = { name: 'minimal', content: 'A simple agent.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('read');
      expect(result.mode.tools).toContain('edit');
    });

    it('infers "terminal" tool from "terminal" keyword', () => {
      const agent = { name: 'test', content: 'Run commands in the terminal.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('terminal');
    });

    it('infers "terminal" tool from "bash" keyword', () => {
      const agent = { name: 'test', content: 'Execute bash scripts.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('terminal');
    });

    it('infers "terminal" tool from "command" keyword', () => {
      const agent = { name: 'test', content: 'Run the command to deploy.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('terminal');
    });

    it('infers "search" tool from "search" keyword', () => {
      const agent = { name: 'test', content: 'Search the codebase for patterns.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('search');
    });

    it('infers "search" tool from "grep" keyword', () => {
      const agent = { name: 'test', content: 'Use grep to find imports.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('search');
    });

    it('infers "search" tool from "find" keyword', () => {
      const agent = { name: 'test', content: 'Find all test files.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('search');
    });

    it('infers "web" tool from "web" keyword', () => {
      const agent = { name: 'test', content: 'Access web resources.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('web');
    });

    it('infers "web" tool from "fetch" keyword', () => {
      const agent = { name: 'test', content: 'Fetch data from the API.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('web');
    });

    it('infers "web" tool from "url" keyword', () => {
      const agent = { name: 'test', content: 'Navigate to the URL endpoint.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('web');
    });

    it('infers "mcp" tool from "mcp" keyword', () => {
      const agent = { name: 'test', content: 'Uses MCP servers for analysis.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('mcp');
    });

    it('does not include "terminal" when no matching keywords', () => {
      const agent = { name: 'test', content: 'Read and write files only.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).not.toContain('terminal');
    });

    it('does not include "search" when no matching keywords', () => {
      const agent = { name: 'test', content: 'Read and edit source code.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).not.toContain('search');
    });

    it('does not include "web" when no matching keywords', () => {
      const agent = { name: 'test', content: 'Read and edit local files only.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).not.toContain('web');
    });

    it('does not include "mcp" when no matching keywords', () => {
      const agent = { name: 'test', content: 'Basic file operations.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).not.toContain('mcp');
    });

    it('does not duplicate tools when multiple matching keywords exist', () => {
      const agent = { name: 'test', content: 'Search and grep and find all patterns.' };
      const result = adapter.convertAgent(agent);
      const searchCount = result.mode.tools.filter((t) => t === 'search').length;
      expect(searchCount).toBe(1);
    });

    it('does not duplicate "read" or "edit" base tools even if mentioned in content', () => {
      const agent = { name: 'test', content: 'Read and edit files using read and edit.' };
      const result = adapter.convertAgent(agent);
      const readCount = result.mode.tools.filter((t) => t === 'read').length;
      const editCount = result.mode.tools.filter((t) => t === 'edit').length;
      expect(readCount).toBe(1);
      expect(editCount).toBe(1);
    });

    it('infers multiple tools from content with many keywords', () => {
      const agent = {
        name: 'full',
        content: 'Use terminal to search web pages via mcp and fetch URLs with bash commands.',
      };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('read');
      expect(result.mode.tools).toContain('edit');
      expect(result.mode.tools).toContain('terminal');
      expect(result.mode.tools).toContain('search');
      expect(result.mode.tools).toContain('web');
      expect(result.mode.tools).toContain('mcp');
    });

    it('performs case-insensitive keyword matching', () => {
      const agent = { name: 'test', content: 'Use the TERMINAL and SEARCH tools.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('terminal');
      expect(result.mode.tools).toContain('search');
    });

    it('performs case-insensitive matching for "web" keyword', () => {
      const agent = { name: 'test', content: 'Access WEB endpoints via FETCH requests at URL.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('web');
    });

    it('performs case-insensitive matching for "mcp" keyword', () => {
      const agent = { name: 'test', content: 'Use MCP protocol servers.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools).toContain('mcp');
    });

    it('returns tools as an array with at least 2 elements (read + edit)', () => {
      const agent = { name: 'minimal', content: 'Simple.' };
      const result = adapter.convertAgent(agent);
      expect(result.mode.tools.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('convertCommand()', () => {
    const baseCommand = { name: 'analyze', content: '## Analyze\n\nRuns analysis on the codebase.' };

    it('returns path under .cursor/prompts with .md extension', () => {
      const result = adapter.convertCommand(baseCommand);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.cursor/prompts/analyze.md');
    });

    it('preserves original command content as-is', () => {
      const result = adapter.convertCommand(baseCommand);
      expect(result.content).toBe(baseCommand.content);
    });

    it('handles command names with hyphens', () => {
      const command = { name: 'run-tests', content: 'Run test suite.' };
      const result = adapter.convertCommand(command);
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.cursor/prompts/run-tests.md');
    });

    it('handles command with empty content', () => {
      const command = { name: 'noop', content: '' };
      const result = adapter.convertCommand(command);
      expect(result.content).toBe('');
      const normalized = result.path.replace(/\\/g, '/');
      expect(normalized).toBe('.cursor/prompts/noop.md');
    });

    it('handles command with multiline content', () => {
      const command = {
        name: 'build',
        content: '## Build\n\nStep 1: Compile\nStep 2: Link\nStep 3: Package',
      };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('Step 1: Compile');
      expect(result.content).toContain('Step 3: Package');
    });
  });

  describe('generateModesJson()', () => {
    it('generates .cursor/modes.json from mode entries', () => {
      const modeEntries = [
        { mode: { name: 'frontend', customPrompt: 'Frontend agent', tools: ['read', 'edit'] } },
        { mode: { name: 'backend', customPrompt: 'Backend agent', tools: ['read', 'edit', 'terminal'] } },
      ];
      const result = adapter.generateModesJson(modeEntries);
      expect(result.path).toBe('.cursor/modes.json');
    });

    it('outputs valid JSON with modes array', () => {
      const modeEntries = [
        { mode: { name: 'test', customPrompt: 'Test agent', tools: ['read'] } },
      ];
      const result = adapter.generateModesJson(modeEntries);
      const parsed = JSON.parse(result.content);
      expect(parsed.modes).toBeDefined();
      expect(Array.isArray(parsed.modes)).toBe(true);
      expect(parsed.modes).toHaveLength(1);
      expect(parsed.modes[0].name).toBe('test');
    });

    it('filters out entries without a mode property', () => {
      const modeEntries = [
        { mode: { name: 'valid', customPrompt: 'Valid', tools: [] } },
        { path: 'some/file.md', content: 'No mode here' },
        { mode: null },
      ];
      const result = adapter.generateModesJson(modeEntries);
      const parsed = JSON.parse(result.content);
      expect(parsed.modes).toHaveLength(1);
      expect(parsed.modes[0].name).toBe('valid');
    });

    it('filters out entries with undefined mode property', () => {
      const modeEntries = [
        { mode: { name: 'good', customPrompt: 'Good', tools: [] } },
        { mode: undefined },
        {},
      ];
      const result = adapter.generateModesJson(modeEntries);
      const parsed = JSON.parse(result.content);
      expect(parsed.modes).toHaveLength(1);
      expect(parsed.modes[0].name).toBe('good');
    });

    it('filters out entries with false mode property', () => {
      const modeEntries = [
        { mode: { name: 'real', customPrompt: 'Real', tools: [] } },
        { mode: false },
      ];
      const result = adapter.generateModesJson(modeEntries);
      const parsed = JSON.parse(result.content);
      expect(parsed.modes).toHaveLength(1);
    });

    it('content is pretty-printed JSON ending with newline', () => {
      const modeEntries = [
        { mode: { name: 'x', customPrompt: 'X', tools: [] } },
      ];
      const result = adapter.generateModesJson(modeEntries);
      expect(result.content).toContain('\n');
      expect(result.content.endsWith('\n')).toBe(true);
      // Verify it's indented (pretty-printed)
      expect(result.content).toContain('  ');
    });

    it('handles empty mode entries array', () => {
      const result = adapter.generateModesJson([]);
      const parsed = JSON.parse(result.content);
      expect(parsed.modes).toEqual([]);
    });

    it('preserves tool arrays in each mode', () => {
      const modeEntries = [
        { mode: { name: 'full', customPrompt: 'Full', tools: ['read', 'edit', 'terminal', 'search'] } },
      ];
      const result = adapter.generateModesJson(modeEntries);
      const parsed = JSON.parse(result.content);
      expect(parsed.modes[0].tools).toEqual(['read', 'edit', 'terminal', 'search']);
    });

    it('preserves multiple modes in output order', () => {
      const modeEntries = [
        { mode: { name: 'alpha', customPrompt: 'Alpha', tools: [] } },
        { mode: { name: 'beta', customPrompt: 'Beta', tools: [] } },
        { mode: { name: 'gamma', customPrompt: 'Gamma', tools: [] } },
      ];
      const result = adapter.generateModesJson(modeEntries);
      const parsed = JSON.parse(result.content);
      expect(parsed.modes).toHaveLength(3);
      expect(parsed.modes[0].name).toBe('alpha');
      expect(parsed.modes[1].name).toBe('beta');
      expect(parsed.modes[2].name).toBe('gamma');
    });
  });

  describe('generateManifest()', () => {
    it('returns path as .cursorrules', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.path).toBe('.cursorrules');
    });

    it('includes version from config', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('Version: 1.3.0');
    });

    it('defaults version to 1.1.0 when not in config', () => {
      const noVersionAdapter = new CursorAdapter({ pluginRoot: '/root', config: {} });
      const manifest = noVersionAdapter.generateManifest();
      expect(manifest.content).toContain('Version: 1.1.0');
    });

    it('defaults version to 1.1.0 when config has agents but no version', () => {
      const agentsNoVersionAdapter = new CursorAdapter({
        pluginRoot: '/root',
        config: { agents: { taskBased: { qa: 'qa-engineer' } } },
      });
      const manifest = agentsNoVersionAdapter.generateManifest();
      expect(manifest.content).toContain('Version: 1.1.0');
    });

    it('includes core principles section', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('## Core Principles');
      expect(manifest.content).toContain('Evidence > assumptions');
    });

    it('includes coding standards section', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('## Coding Standards');
      expect(manifest.content).toContain('Functions < 50 lines');
    });

    it('includes project structure section', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('## Project Structure');
      expect(manifest.content).toContain('agents/');
      expect(manifest.content).toContain('skills/');
    });

    it('includes immutability principle', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('Immutability');
    });

    it('includes test-driven development principle', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('Test-driven development');
    });

    it('includes no-deep-nesting coding standard', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('No deep nesting');
    });

    it('includes error handling coding standard', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content).toContain('error handling');
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
        platform: 'cursor',
        files: [{ path: '.cursorrules', content: '# Rules\n' }],
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
      const result = { platform: 'cursor', files: [], warnings: [] };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(false);
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
        content: 'Test content.',
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
      const cmd = adapter.convertCommand({ name: 'build', content: '## Build the project.' });
      const result = {
        platform: adapter.platformId,
        files: [cmd],
        warnings: [],
      };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(true);
    });

    it('validates modes.json output end-to-end', () => {
      const agentEntry = adapter.convertAgent({ name: 'frontend', content: 'Frontend content.' });
      const modeFile = adapter.generateModesJson([agentEntry]);
      const result = {
        platform: adapter.platformId,
        files: [modeFile],
        warnings: [],
      };
      const { valid } = adapter.validate(result);
      expect(valid).toBe(true);
    });
  });
});
