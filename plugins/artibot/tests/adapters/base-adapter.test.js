import { describe, it, expect, beforeEach } from 'vitest';
import { BaseAdapter } from '../../lib/adapters/base-adapter.js';
import { GeminiAdapter } from '../../lib/adapters/gemini-adapter.js';

// Concrete subclass for testing abstract methods
class ConcreteAdapter extends BaseAdapter {
  get platformId() { return 'test-platform'; }
  get platformName() { return 'Test Platform'; }
  get instructionFileName() { return 'TEST.md'; }
  get skillsDir() { return '.test/skills'; }
  convertSkill(skill) {
    return { path: `${this.skillsDir}/${skill.dirName}/SKILL.md`, content: skill.content };
  }
  convertAgent(agent) {
    return { path: `agents/${agent.name}.md`, content: agent.content };
  }
  convertCommand(command) {
    return { path: `commands/${command.name}.md`, content: command.content };
  }
  generateManifest() {
    return { path: 'manifest.json', content: '{}' };
  }
}

// Partial subclass that does NOT override abstract getters/methods
// Used to verify the base class throws for unimplemented members
class PartialAdapter extends BaseAdapter {}

describe('BaseAdapter (abstract)', () => {
  it('throws when instantiated directly', () => {
    expect(() => new BaseAdapter({ pluginRoot: '/root', config: {} })).toThrow(
      'BaseAdapter is abstract',
    );
  });

  it('stores pluginRoot and config from constructor', () => {
    const adapter = new ConcreteAdapter({ pluginRoot: '/my/root', config: { version: '1.0.0' } });
    expect(adapter.pluginRoot).toBe('/my/root');
    expect(adapter.config.version).toBe('1.0.0');
  });

  it('concrete subclass returns correct platformId', () => {
    const adapter = new ConcreteAdapter({ pluginRoot: '/root', config: {} });
    expect(adapter.platformId).toBe('test-platform');
  });

  it('concrete subclass returns correct platformName', () => {
    const adapter = new ConcreteAdapter({ pluginRoot: '/root', config: {} });
    expect(adapter.platformName).toBe('Test Platform');
  });

  it('concrete subclass returns correct instructionFileName', () => {
    const adapter = new ConcreteAdapter({ pluginRoot: '/root', config: {} });
    expect(adapter.instructionFileName).toBe('TEST.md');
  });

  it('concrete subclass returns correct skillsDir', () => {
    const adapter = new ConcreteAdapter({ pluginRoot: '/root', config: {} });
    expect(adapter.skillsDir).toBe('.test/skills');
  });
});

describe('BaseAdapter unimplemented abstract members', () => {
  // PartialAdapter can be instantiated (new.target !== BaseAdapter),
  // but accessing any unimplemented getter/method throws.
  let partial;

  beforeEach(() => {
    partial = new PartialAdapter({ pluginRoot: '/root', config: {} });
  });

  it('throws on platformId when not implemented', () => {
    expect(() => partial.platformId).toThrow('must implement platformId');
  });

  it('throws on platformName when not implemented', () => {
    expect(() => partial.platformName).toThrow('must implement platformName');
  });

  it('throws on instructionFileName when not implemented', () => {
    expect(() => partial.instructionFileName).toThrow('must implement instructionFileName');
  });

  it('throws on skillsDir when not implemented', () => {
    expect(() => partial.skillsDir).toThrow('must implement skillsDir');
  });

  it('throws on convertSkill() when not implemented', () => {
    expect(() => partial.convertSkill({})).toThrow('must implement convertSkill()');
  });

  it('throws on convertAgent() when not implemented', () => {
    expect(() => partial.convertAgent({})).toThrow('must implement convertAgent()');
  });

  it('throws on convertCommand() when not implemented', () => {
    expect(() => partial.convertCommand({})).toThrow('must implement convertCommand()');
  });

  it('throws on generateManifest() when not implemented', () => {
    expect(() => partial.generateManifest()).toThrow('must implement generateManifest()');
  });

  it('error messages include the subclass constructor name', () => {
    expect(() => partial.platformId).toThrow('PartialAdapter');
  });
});

describe('BaseAdapter.validate()', () => {
  let adapter;
  beforeEach(() => {
    adapter = new ConcreteAdapter({ pluginRoot: '/root', config: {} });
  });

  it('passes valid result with files', () => {
    const result = {
      platform: 'test-platform',
      files: [{ path: 'some/file.md', content: 'content' }],
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

  it('fails when platform is empty string', () => {
    const result = { platform: '', files: [{ path: 'f.md', content: '' }], warnings: [] };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(false);
    expect(errors).toContain('Missing platform identifier');
  });

  it('fails when files array is empty', () => {
    const result = { platform: 'test', files: [], warnings: [] };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('No files'))).toBe(true);
  });

  it('fails when files is undefined', () => {
    const result = { platform: 'test', warnings: [] };
    const { valid, errors: _errors } = adapter.validate(result);
    expect(valid).toBe(false);
  });

  it('fails when files is null (treated as no files)', () => {
    const result = { platform: 'test', files: null, warnings: [] };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('No files'))).toBe(true);
  });

  it('fails when a file entry is missing path', () => {
    const result = {
      platform: 'test',
      files: [{ content: 'some content' }],
      warnings: [],
    };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('missing path'))).toBe(true);
  });

  it('fails when a file entry has non-string content', () => {
    const result = {
      platform: 'test',
      files: [{ path: 'file.md', content: 42 }],
      warnings: [],
    };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('content must be a string'))).toBe(true);
  });

  it('fails when a file entry has null content', () => {
    const result = {
      platform: 'test',
      files: [{ path: 'file.md', content: null }],
      warnings: [],
    };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('content must be a string'))).toBe(true);
  });

  it('fails when a file entry has object content', () => {
    const result = {
      platform: 'test',
      files: [{ path: 'file.md', content: { data: true } }],
      warnings: [],
    };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('content must be a string'))).toBe(true);
  });

  it('returns multiple errors when multiple issues exist', () => {
    const result = { files: [], warnings: [] };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('accumulates errors for multiple bad file entries', () => {
    const result = {
      platform: 'test',
      files: [
        { content: 'missing path' },
        { path: 'ok.md', content: 123 },
      ],
      warnings: [],
    };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('missing path'))).toBe(true);
    expect(errors.some((e) => e.includes('content must be a string'))).toBe(true);
  });

  it('passes when file content is empty string', () => {
    const result = {
      platform: 'test',
      files: [{ path: 'empty.md', content: '' }],
      warnings: [],
    };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it('passes when multiple valid files are provided', () => {
    const result = {
      platform: 'test',
      files: [
        { path: 'file1.md', content: 'content one' },
        { path: 'file2.md', content: 'content two' },
        { path: 'file3.yaml', content: 'name: test\n' },
      ],
      warnings: [],
    };
    const { valid, errors } = adapter.validate(result);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it('valid field is false when any errors present', () => {
    const result = { platform: 'test', files: [], warnings: [] };
    const { valid } = adapter.validate(result);
    expect(valid).toBe(false);
  });

  it('valid field is boolean true on success', () => {
    const result = { platform: 'test', files: [{ path: 'a.md', content: 'ok' }], warnings: [] };
    const { valid } = adapter.validate(result);
    expect(typeof valid).toBe('boolean');
    expect(valid).toBe(true);
  });
});

describe('GeminiAdapter', () => {
  let adapter;
  beforeEach(() => {
    adapter = new GeminiAdapter({ pluginRoot: '/root', config: { version: '1.1.0' } });
  });

  it('returns correct platformId', () => {
    expect(adapter.platformId).toBe('gemini-cli');
  });

  it('returns correct platformName', () => {
    expect(adapter.platformName).toBe('Gemini CLI');
  });

  it('returns correct instructionFileName', () => {
    expect(adapter.instructionFileName).toBe('GEMINI.md');
  });

  it('returns correct skillsDir', () => {
    expect(adapter.skillsDir).toBe('.agent/skills');
  });

  it('convertSkill returns path with skillsDir and dirName', () => {
    const skill = {
      name: 'persona-architect',
      description: 'Architect persona',
      dirName: 'persona-architect',
      content: 'This is a CLAUDE.md skill content',
    };
    const result = adapter.convertSkill(skill);
    // Use path.normalize for cross-platform comparison
    expect(result.path).toContain('persona-architect');
    expect(result.path).toContain('SKILL.md');
    // Path contains skills dir segment (forward or backslash)
    expect(result.path.replace(/\\/g, '/')).toContain('.agent/skills');
  });

  it('convertSkill replaces Claude Code references with AI Agent', () => {
    const skill = {
      name: 'test-skill',
      description: 'Test',
      dirName: 'test-skill',
      content: 'This uses Claude Code and .claude/skills/ paths',
    };
    const result = adapter.convertSkill(skill);
    expect(result.content).not.toContain('Claude Code');
    expect(result.content).toContain('AI Agent');
  });

  it('convertSkill replaces .claude/skills/ with .agent/skills/', () => {
    const skill = {
      name: 'test',
      description: 'Test',
      dirName: 'test',
      content: 'See .claude/skills/example for reference',
    };
    const result = adapter.convertSkill(skill);
    expect(result.content).toContain('.agent/skills/');
  });

  it('convertSkill includes YAML frontmatter', () => {
    const skill = {
      name: 'my-skill',
      description: 'Short description',
      dirName: 'my-skill',
      content: 'Body content here',
    };
    const result = adapter.convertSkill(skill);
    expect(result.content).toMatch(/^---/);
    expect(result.content).toContain('name: my-skill');
  });

  it('convertAgent returns path under agents/', () => {
    const agent = { name: 'frontend', content: 'Agent using TeamCreate to form teams' };
    const result = adapter.convertAgent(agent);
    // normalize path separators for cross-platform
    expect(result.path.replace(/\\/g, '/')).toBe('agents/frontend.md');
  });

  it('convertAgent strips AgentTeams API references', () => {
    const agent = { name: 'test', content: 'Uses TeamCreate and TeamDelete for CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' };
    const result = adapter.convertAgent(agent);
    expect(result.content).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
    expect(result.content).not.toContain('TeamCreate');
  });

  it('convertCommand returns path under commands/ with .toml extension', () => {
    const command = { name: 'build', content: '## Build Command\n\nBuilds the project.' };
    const result = adapter.convertCommand(command);
    expect(result.path.replace(/\\/g, '/')).toBe('commands/build.toml');
  });

  it('convertCommand generates valid TOML with [command] section', () => {
    const command = { name: 'analyze', content: '## Analyze\n\nRuns analysis on the codebase.' };
    const result = adapter.convertCommand(command);
    expect(result.content).toContain('[command]');
    expect(result.content).toContain('name = "analyze"');
  });

  it('generateManifest returns gemini-extension.json path', () => {
    const manifest = adapter.generateManifest();
    expect(manifest.path).toBe('gemini-extension.json');
  });

  it('generateManifest content is valid JSON', () => {
    const manifest = adapter.generateManifest();
    const parsed = JSON.parse(manifest.content);
    expect(parsed.name).toBe('artibot');
    expect(parsed.version).toBe('1.1.0');
    expect(parsed.contextFileName).toBe('GEMINI.md');
  });

  it('validate passes for properly generated output', () => {
    const result = {
      platform: adapter.platformId,
      files: [adapter.generateManifest()],
      warnings: [],
    };
    const { valid } = adapter.validate(result);
    expect(valid).toBe(true);
  });
});
