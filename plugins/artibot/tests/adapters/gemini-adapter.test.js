import { describe, it, expect, beforeEach } from 'vitest';
import { GeminiAdapter } from '../../lib/adapters/gemini-adapter.js';
import { BaseAdapter } from '../../lib/adapters/base-adapter.js';

describe('GeminiAdapter', () => {
  /** @type {GeminiAdapter} */
  let adapter;

  const defaultConfig = {
    version: '1.4.0',
    agents: {
      taskBased: {
        frontend: 'frontend-developer',
        backend: 'backend-developer',
      },
    },
  };

  beforeEach(() => {
    adapter = new GeminiAdapter({ pluginRoot: '/project/root', config: defaultConfig });
  });

  describe('inheritance and identity', () => {
    it('extends BaseAdapter', () => {
      expect(adapter).toBeInstanceOf(BaseAdapter);
    });

    it('stores pluginRoot and config', () => {
      expect(adapter.pluginRoot).toBe('/project/root');
      expect(adapter.config).toBe(defaultConfig);
    });
  });

  describe('convertCommand() - TOML generation', () => {
    it('generates TOML with [command] section and name', () => {
      const command = { name: 'analyze', content: '## Analyze\n\nRuns analysis.' };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('[command]');
      expect(result.content).toContain('name = "analyze"');
    });

    it('extracts first non-heading, non-separator paragraph for description', () => {
      const command = {
        name: 'build',
        content: '# Build Command\n\nThis builds the project.',
      };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('description = "This builds the project."');
    });

    it('handles content where first paragraph is on first line', () => {
      const command = { name: 'test', content: 'Run all tests in the project.' };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('description = "Run all tests in the project."');
    });

    it('truncates description to 200 characters', () => {
      const longLine = 'A'.repeat(250);
      const command = { name: 'long', content: longLine };
      const result = adapter.convertCommand(command);
      // The description value should be at most 200 chars (before escaping)
      const descMatch = result.content.match(/description = "([^"]*)"/);
      expect(descMatch).not.toBeNull();
      expect(descMatch[1].length).toBeLessThanOrEqual(200);
    });

    it('uses empty string when content has only headings', () => {
      const command = { name: 'empty', content: '# Only Heading\n## Another Heading' };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('description = ""');
    });

    it('extracts first non-heading line even inside frontmatter-like block', () => {
      // extractFirstParagraph does not parse YAML frontmatter blocks,
      // it treats each line individually
      const command = { name: 'fm', content: '---\nkey: val\n---\n# Heading' };
      const result = adapter.convertCommand(command);
      // 'key: val' is the first line that isn't empty, heading, or ---
      expect(result.content).toContain('description = "key: val"');
    });

    it('wraps body in triple-quoted TOML text block', () => {
      const command = { name: 'wrap', content: 'Body content here.' };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('[command.prompt]');
      expect(result.content).toContain('text = """');
      expect(result.content).toContain('Body content here.');
    });

    it('escapes triple quotes in body content', () => {
      const command = { name: 'escape', content: 'Some """triple quotes""" in body.' };
      const result = adapter.convertCommand(command);
      // Triple quotes should be escaped
      expect(result.content).not.toContain('Some """triple');
    });

    it('escapes backslashes in description', () => {
      const command = { name: 'esc', content: 'Path is C:\\Users\\file' };
      const result = adapter.convertCommand(command);
      // escapeToml doubles backslashes
      expect(result.content).toContain('C:\\\\Users\\\\file');
    });

    it('escapes double quotes in description', () => {
      const command = { name: 'esc2', content: 'Say "hello" today' };
      const result = adapter.convertCommand(command);
      // escapeToml escapes double quotes
      expect(result.content).toContain('\\"hello\\"');
    });

    it('ends content with newline', () => {
      const command = { name: 'nl', content: 'Content' };
      const result = adapter.convertCommand(command);
      expect(result.content.endsWith('\n')).toBe(true);
    });

    it('includes auto-generated comment header', () => {
      const command = { name: 'header', content: 'Content' };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('# header command');
      expect(result.content).toContain('# Auto-generated from Artibot');
    });

    it('handles empty content gracefully', () => {
      const command = { name: 'empty', content: '' };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('[command]');
      expect(result.content).toContain('name = "empty"');
      expect(result.content).toContain('description = ""');
    });

    it('skips heading lines when extracting description', () => {
      const command = { name: 'heading', content: '# Title\n## Subtitle\nActual description here.' };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('description = "Actual description here."');
    });

    it('skips empty lines when extracting description', () => {
      const command = { name: 'blank', content: '\n\n\nFirst real line.' };
      const result = adapter.convertCommand(command);
      expect(result.content).toContain('description = "First real line."');
    });
  });

  describe('generateManifest()', () => {
    it('defaults version to 1.1.0 when config has no version', () => {
      const noVersionAdapter = new GeminiAdapter({ pluginRoot: '/root', config: {} });
      const manifest = noVersionAdapter.generateManifest();
      const parsed = JSON.parse(manifest.content);
      expect(parsed.version).toBe('1.1.0');
    });

    it('includes excludeTools and settings arrays', () => {
      const manifest = adapter.generateManifest();
      const parsed = JSON.parse(manifest.content);
      expect(Array.isArray(parsed.excludeTools)).toBe(true);
      expect(Array.isArray(parsed.settings)).toBe(true);
    });

    it('content ends with newline', () => {
      const manifest = adapter.generateManifest();
      expect(manifest.content.endsWith('\n')).toBe(true);
    });
  });

  describe('convertAgent()', () => {
    it('replaces Claude Code with AI Agent Platform in agent content', () => {
      const agent = { name: 'test', content: 'Claude Code orchestrates the workflow.' };
      const result = adapter.convertAgent(agent);
      expect(result.content).toContain('AI Agent Platform');
    });

    it('strips SendMessage plan_approval_response references', () => {
      const agent = { name: 'test', content: 'SendMessage(type: "plan_approval_response") to approve' };
      const result = adapter.convertAgent(agent);
      expect(result.content).not.toContain('SendMessage(type: "plan_approval_response")');
    });
  });
});
