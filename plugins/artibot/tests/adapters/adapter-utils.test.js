import { describe, it, expect } from 'vitest';
import {
  buildFrontmatter,
  cleanDescription,
  stripAgentTeamsRefs,
  stripClaudeSpecificRefs,
} from '../../lib/adapters/adapter-utils.js';

describe('buildFrontmatter()', () => {
  it('wraps fields in YAML frontmatter delimiters', () => {
    const result = buildFrontmatter({ name: 'test' });
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\n---$/);
  });

  it('renders simple string fields as key: value', () => {
    const result = buildFrontmatter({ name: 'my-skill', description: 'A skill' });
    expect(result).toContain('name: my-skill');
    expect(result).toContain('description: A skill');
  });

  it('renders multiline strings as YAML block scalar', () => {
    const result = buildFrontmatter({ description: 'Line one\nLine two' });
    expect(result).toContain('description: |');
    expect(result).toContain('  Line one');
    expect(result).toContain('  Line two');
  });

  it('renders array values as YAML inline arrays', () => {
    const result = buildFrontmatter({ platforms: ['claude', 'gemini', 'codex'] });
    expect(result).toContain('platforms: [claude, gemini, codex]');
  });

  it('handles empty array', () => {
    const result = buildFrontmatter({ tags: [] });
    expect(result).toContain('tags: []');
  });

  it('handles single-element array', () => {
    const result = buildFrontmatter({ platforms: ['claude'] });
    expect(result).toContain('platforms: [claude]');
  });

  it('handles empty object', () => {
    const result = buildFrontmatter({});
    expect(result).toBe('---\n---');
  });

  it('handles multiple fields in order', () => {
    const result = buildFrontmatter({ name: 'a', version: '1.0' });
    const nameIdx = result.indexOf('name: a');
    const versionIdx = result.indexOf('version: 1.0');
    expect(nameIdx).toBeLessThan(versionIdx);
  });

  it('handles string with no newlines as simple value', () => {
    const result = buildFrontmatter({ title: 'Simple title' });
    expect(result).toContain('title: Simple title');
    expect(result).not.toContain('title: |');
  });
});

describe('cleanDescription()', () => {
  it('trims trailing whitespace from each line', () => {
    const result = cleanDescription('hello   \nworld  ');
    expect(result).toBe('hello\nworld');
  });

  it('trims leading and trailing whitespace from result', () => {
    const result = cleanDescription('  padded  ');
    expect(result).toBe('padded');
  });

  it('returns empty string for empty input', () => {
    expect(cleanDescription('')).toBe('');
  });

  it('returns empty string for null input', () => {
    expect(cleanDescription(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(cleanDescription(undefined)).toBe('');
  });

  it('preserves leading whitespace within lines (indentation)', () => {
    const result = cleanDescription('  indented\n    more indented');
    expect(result).toBe('indented\n    more indented');
  });

  it('handles single line without trailing whitespace', () => {
    expect(cleanDescription('clean')).toBe('clean');
  });

  it('handles multiline with mixed trailing whitespace', () => {
    const result = cleanDescription('line1  \nline2\nline3   ');
    expect(result).toBe('line1\nline2\nline3');
  });
});

describe('stripAgentTeamsRefs()', () => {
  it('replaces TeamCreate and TeamDelete with (team coordination)', () => {
    const result = stripAgentTeamsRefs('Use TeamCreate and TeamDelete');
    expect(result).not.toContain('TeamCreate');
    expect(result).not.toContain('TeamDelete');
    expect(result).toContain('(team coordination)');
  });

  it('replaces SendMessage(type: "broadcast") with (agent communication)', () => {
    const result = stripAgentTeamsRefs('Call SendMessage(type: "broadcast") to all');
    expect(result).not.toContain('SendMessage(type: "broadcast")');
    expect(result).toContain('(agent communication)');
  });

  it('replaces SendMessage(type: "shutdown_request") with (agent communication)', () => {
    const result = stripAgentTeamsRefs('SendMessage(type: "shutdown_request") to stop');
    expect(result).toContain('(agent communication)');
  });

  it('replaces SendMessage(type: "shutdown_response") with (agent communication)', () => {
    const result = stripAgentTeamsRefs('SendMessage(type: "shutdown_response") to ack');
    expect(result).toContain('(agent communication)');
  });

  it('replaces SendMessage(type: "plan_approval_response") with (agent communication)', () => {
    const result = stripAgentTeamsRefs('SendMessage(type: "plan_approval_response") to approve');
    expect(result).toContain('(agent communication)');
  });

  it('replaces CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS with default label', () => {
    const result = stripAgentTeamsRefs('Set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');
    expect(result).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
    expect(result).toContain('(platform agent teams)');
  });

  it('uses custom envLabel from mapping when provided', () => {
    const result = stripAgentTeamsRefs(
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS required',
      { envLabel: '(custom platform)' },
    );
    expect(result).toContain('(custom platform)');
    expect(result).not.toContain('(platform agent teams)');
  });

  it('replaces "Claude Code" with "AI Agent Platform"', () => {
    const result = stripAgentTeamsRefs('Claude Code is the engine');
    expect(result).not.toContain('Claude Code');
    expect(result).toContain('AI Agent Platform');
  });

  it('handles content with no API references unchanged', () => {
    const input = 'No API references here.';
    const result = stripAgentTeamsRefs(input);
    expect(result).toBe(input);
  });

  it('handles multiple replacements in a single string', () => {
    const input = 'TeamCreate + TeamDelete + Claude Code + CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
    const result = stripAgentTeamsRefs(input);
    expect(result).not.toContain('TeamCreate');
    expect(result).not.toContain('TeamDelete');
    expect(result).not.toContain('Claude Code');
    expect(result).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
  });

  it('uses default mapping when mapping is omitted', () => {
    const result = stripAgentTeamsRefs('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
    expect(result).toContain('(platform agent teams)');
  });
});

describe('stripClaudeSpecificRefs()', () => {
  it('replaces .claude/skills/ with mapping.skillsPath', () => {
    const result = stripClaudeSpecificRefs('See .claude/skills/example', {
      skillsPath: '.agent/skills/',
      platformName: 'AI Agent',
      instructionFile: 'GEMINI.md',
    });
    expect(result).not.toContain('.claude/skills/');
    expect(result).toContain('.agent/skills/example');
  });

  it('replaces "Claude Code" with mapping.platformName', () => {
    const result = stripClaudeSpecificRefs('Use Claude Code for this', {
      skillsPath: '.agent/skills/',
      platformName: 'My Platform',
      instructionFile: 'PLATFORM.md',
    });
    expect(result).not.toContain('Claude Code');
    expect(result).toContain('My Platform');
  });

  it('replaces "CLAUDE.md" with mapping.instructionFile', () => {
    const result = stripClaudeSpecificRefs('Read CLAUDE.md for instructions', {
      skillsPath: '.agent/skills/',
      platformName: 'AI Agent',
      instructionFile: 'AGENTS.md',
    });
    expect(result).not.toContain('CLAUDE.md');
    expect(result).toContain('AGENTS.md');
  });

  it('replaces multiple occurrences of each pattern', () => {
    const content = '.claude/skills/a and .claude/skills/b, Claude Code x2 Claude Code, CLAUDE.md and CLAUDE.md';
    const result = stripClaudeSpecificRefs(content, {
      skillsPath: '.test/skills/',
      platformName: 'TestPlatform',
      instructionFile: 'TEST.md',
    });
    expect(result).not.toContain('.claude/skills/');
    expect(result).not.toContain('Claude Code');
    expect(result).not.toContain('CLAUDE.md');
  });

  it('returns content unchanged when no Claude-specific refs exist', () => {
    const input = 'Generic content with no platform references.';
    const result = stripClaudeSpecificRefs(input, {
      skillsPath: '.agent/skills/',
      platformName: 'AI Agent',
      instructionFile: 'GEMINI.md',
    });
    expect(result).toBe(input);
  });

  it('handles all three replacements in a single string', () => {
    const content = 'Use Claude Code, read CLAUDE.md, find .claude/skills/persona';
    const result = stripClaudeSpecificRefs(content, {
      skillsPath: '.cursor/skills/',
      platformName: 'Cursor',
      instructionFile: '.cursorrules',
    });
    expect(result).toContain('Cursor');
    expect(result).toContain('.cursorrules');
    expect(result).toContain('.cursor/skills/persona');
  });
});
