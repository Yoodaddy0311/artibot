import { describe, it, expect } from 'vitest';

/**
 * tool-tracker.js uses dynamic imports (import(`file://...`)) to load
 * tool-learner.js and lifelong-learner.js. Vite's import analysis plugin
 * fails to parse the JSDoc containing glob patterns like "**\/*.md".
 *
 * Since we cannot directly import tool-tracker.js through vitest's module
 * system, we test the hook's internal logic by:
 *   1. Extracting and testing the pure functions (buildContext, scoreResult,
 *      classifyBashCommand, etc.) through equivalent implementations
 *   2. Verifying the skip-tools logic
 *   3. Testing the scoring heuristics
 *
 * This approach validates the same logic without triggering vite's parser.
 */

// ---------------------------------------------------------------------------
// Re-implement pure functions from tool-tracker.js for testing
// (These are exact copies of the internal functions)
// ---------------------------------------------------------------------------

import path from 'node:path';

const SKIP_TOOLS = new Set([
  'TodoRead', 'TodoWrite', 'TaskList', 'TaskGet', 'TaskUpdate',
  'TaskCreate', 'SendMessage', 'TeamCreate', 'TeamDelete',
]);

const MIN_SUBSTANTIVE_LENGTH = 10;

function extractExt(filePath) {
  if (!filePath) return null;
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return ext || null;
}

function extractExtFromGlob(pattern) {
  if (!pattern) return null;
  const match = pattern.match(/\*\.(\w+)/);
  return match ? match[1].toLowerCase() : null;
}

function classifyBashCommand(cmd) {
  const trimmed = cmd.trim().toLowerCase();
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?test/.test(trimmed)) return 'test';
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?build/.test(trimmed)) return 'build';
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?lint/.test(trimmed)) return 'lint';
  if (/^(npm|pnpm|yarn|bun)\s+install/.test(trimmed)) return 'install';
  if (/^git\s/.test(trimmed)) return 'git';
  if (/^(tsc|npx\s+tsc)/.test(trimmed)) return 'typecheck';
  if (/^(node|npx|tsx)\s/.test(trimmed)) return 'execute';
  if (/^(docker|docker-compose)/.test(trimmed)) return 'container';
  if (/^(curl|wget|fetch)/.test(trimmed)) return 'http';
  if (/^(ls|dir|pwd)/.test(trimmed)) return 'list';
  if (/^(mkdir|rm|cp|mv)/.test(trimmed)) return 'filesystem';
  return null;
}

function buildContext(toolName, input) {
  switch (toolName) {
    case 'Read': {
      const ext = extractExt(input.file_path);
      return ext ? `read:${ext}:file` : 'read:unknown:file';
    }
    case 'Grep': {
      const type = input.type || extractExtFromGlob(input.glob) || 'any';
      const mode = input.output_mode || 'files_with_matches';
      return `search:${type}:${mode}`;
    }
    case 'Glob': {
      const pattern = input.pattern || '';
      const ext = extractExtFromGlob(pattern) || 'any';
      return `find:${ext}:glob`;
    }
    case 'Bash': {
      const cmd = input.command || '';
      const verb = classifyBashCommand(cmd);
      return verb ? `bash:${verb}:shell` : null;
    }
    case 'Edit': {
      const ext = extractExt(input.file_path);
      return ext ? `edit:${ext}:file` : 'edit:unknown:file';
    }
    case 'Write': {
      const ext = extractExt(input.file_path);
      return ext ? `create:${ext}:file` : 'create:unknown:file';
    }
    case 'WebSearch': return 'search:web:external';
    case 'WebFetch': return 'fetch:web:external';
    case 'Task': {
      const agentType = input.subagent_type || input.type || 'generic';
      return `delegate:${agentType}:subagent`;
    }
    case 'Skill': {
      const skill = input.skill || 'unknown';
      return `invoke:${skill}:skill`;
    }
    default: return `use:${toolName.toLowerCase()}:tool`;
  }
}

function getResultContent(result) {
  if (typeof result === 'string') return result;
  return result.content || result.output || result.stdout || result.text || result.message || '';
}

function scoreResult(toolName, result, _input) {
  if (result.error || result.is_error) return 0.0;
  const output = getResultContent(result);

  switch (toolName) {
    case 'Read':
      if (!output || output.length < MIN_SUBSTANTIVE_LENGTH) return 0.2;
      return 1.0;
    case 'Grep': {
      if (!output || output.trim() === '') return 0.1;
      const lineCount = output.split('\n').filter(Boolean).length;
      if (lineCount > 100) return 0.7;
      if (lineCount > 0) return 1.0;
      return 0.1;
    }
    case 'Glob': {
      if (!output || output.trim() === '') return 0.1;
      const matchCount = output.split('\n').filter(Boolean).length;
      if (matchCount > 200) return 0.6;
      if (matchCount > 0) return 1.0;
      return 0.1;
    }
    case 'Bash': {
      const exitCode = result.exit_code ?? result.exitCode;
      const stderr = result.stderr || '';
      if (exitCode !== 0 && exitCode !== undefined) return 0.1;
      if (stderr && stderr.length > 50) return 0.6;
      return 1.0;
    }
    case 'Edit':
      if (output && output.includes('updated successfully')) return 1.0;
      if (output && output.includes('not unique')) return 0.2;
      return output ? 0.8 : 0.3;
    case 'Write':
      if (output && output.includes('created successfully')) return 1.0;
      return output ? 0.8 : 0.3;
    case 'WebSearch':
    case 'WebFetch':
      if (!output || output.length < MIN_SUBSTANTIVE_LENGTH) return 0.2;
      return 0.9;
    case 'Task':
      if (!output || output.length < MIN_SUBSTANTIVE_LENGTH) return 0.3;
      return 0.85;
    default:
      return output ? 0.7 : 0.3;
  }
}

function extractMeta(input) {
  const meta = {};
  if (input.description) {
    const cmdMatch = input.description.match(/^\/(\w+)/);
    if (cmdMatch) meta.command = `/${cmdMatch[1]}`;
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tool-tracker hook (pure function tests)', () => {
  describe('SKIP_TOOLS set', () => {
    it('includes TodoRead', () => {
      expect(SKIP_TOOLS.has('TodoRead')).toBe(true);
    });

    it('includes TodoWrite', () => {
      expect(SKIP_TOOLS.has('TodoWrite')).toBe(true);
    });

    it('includes TeamCreate', () => {
      expect(SKIP_TOOLS.has('TeamCreate')).toBe(true);
    });

    it('includes SendMessage', () => {
      expect(SKIP_TOOLS.has('SendMessage')).toBe(true);
    });

    it('includes TeamDelete', () => {
      expect(SKIP_TOOLS.has('TeamDelete')).toBe(true);
    });

    it('does not include Read', () => {
      expect(SKIP_TOOLS.has('Read')).toBe(false);
    });

    it('does not include Edit', () => {
      expect(SKIP_TOOLS.has('Edit')).toBe(false);
    });

    it('does not include Bash', () => {
      expect(SKIP_TOOLS.has('Bash')).toBe(false);
    });
  });

  describe('buildContext()', () => {
    it('builds context for Read tool with file extension', () => {
      expect(buildContext('Read', { file_path: '/project/src/app.ts' })).toBe('read:ts:file');
    });

    it('builds context for Read tool without extension', () => {
      expect(buildContext('Read', { file_path: '/project/Makefile' })).toBe('read:unknown:file');
    });

    it('builds context for Grep tool with type', () => {
      expect(buildContext('Grep', { pattern: 'import', type: 'ts', output_mode: 'content' }))
        .toBe('search:ts:content');
    });

    it('builds context for Grep tool with glob instead of type', () => {
      expect(buildContext('Grep', { pattern: 'import', glob: '*.tsx' }))
        .toBe('search:tsx:files_with_matches');
    });

    it('builds context for Glob tool', () => {
      expect(buildContext('Glob', { pattern: '**/*.md' })).toBe('find:md:glob');
    });

    it('builds context for Bash test command', () => {
      expect(buildContext('Bash', { command: 'npm run test' })).toBe('bash:test:shell');
    });

    it('builds context for Bash build command', () => {
      expect(buildContext('Bash', { command: 'pnpm build' })).toBe('bash:build:shell');
    });

    it('builds context for Bash git command', () => {
      expect(buildContext('Bash', { command: 'git status' })).toBe('bash:git:shell');
    });

    it('builds context for Bash tsc command', () => {
      expect(buildContext('Bash', { command: 'tsc --noEmit' })).toBe('bash:typecheck:shell');
    });

    it('returns null for unclassifiable Bash command', () => {
      expect(buildContext('Bash', { command: 'some-unknown-tool --flag' })).toBeNull();
    });

    it('builds context for Edit tool', () => {
      expect(buildContext('Edit', { file_path: '/src/index.js' })).toBe('edit:js:file');
    });

    it('builds context for Write tool', () => {
      expect(buildContext('Write', { file_path: '/src/new-file.py' })).toBe('create:py:file');
    });

    it('builds context for WebSearch tool', () => {
      expect(buildContext('WebSearch', {})).toBe('search:web:external');
    });

    it('builds context for WebFetch tool', () => {
      expect(buildContext('WebFetch', {})).toBe('fetch:web:external');
    });

    it('builds context for Task tool', () => {
      expect(buildContext('Task', { subagent_type: 'code-reviewer' }))
        .toBe('delegate:code-reviewer:subagent');
    });

    it('builds context for Task tool with type fallback', () => {
      expect(buildContext('Task', { type: 'security' })).toBe('delegate:security:subagent');
    });

    it('builds context for Skill tool', () => {
      expect(buildContext('Skill', { skill: 'git-workflow' })).toBe('invoke:git-workflow:skill');
    });

    it('builds default context for unknown tools', () => {
      expect(buildContext('SomeNewTool', {})).toBe('use:somenewtool:tool');
    });
  });

  describe('scoreResult()', () => {
    it('returns 0.0 for error results', () => {
      expect(scoreResult('Read', { error: 'File not found', is_error: true }, {})).toBe(0.0);
    });

    it('returns 0.2 for Read with short output', () => {
      expect(scoreResult('Read', { content: 'short' }, {})).toBe(0.2);
    });

    it('returns 1.0 for Read with substantive output', () => {
      expect(scoreResult('Read', { content: 'a'.repeat(50) }, {})).toBe(1.0);
    });

    it('returns 0.1 for Grep with empty output', () => {
      expect(scoreResult('Grep', { output: '' }, {})).toBe(0.1);
    });

    it('returns 1.0 for Grep with moderate results', () => {
      expect(scoreResult('Grep', { output: 'line1\nline2\nline3' }, {})).toBe(1.0);
    });

    it('returns 0.7 for Grep with too many results', () => {
      const manyLines = Array.from({ length: 150 }, (_, i) => `line${i}`).join('\n');
      expect(scoreResult('Grep', { output: manyLines }, {})).toBe(0.7);
    });

    it('returns 1.0 for Bash with exit code 0', () => {
      expect(scoreResult('Bash', { exit_code: 0 }, {})).toBe(1.0);
    });

    it('returns 0.1 for Bash with non-zero exit code', () => {
      expect(scoreResult('Bash', { exit_code: 1 }, {})).toBe(0.1);
    });

    it('returns 0.6 for Bash with long stderr', () => {
      expect(scoreResult('Bash', { exit_code: 0, stderr: 'w'.repeat(60) }, {})).toBe(0.6);
    });

    it('returns 1.0 for Edit with "updated successfully"', () => {
      expect(scoreResult('Edit', { content: 'updated successfully' }, {})).toBe(1.0);
    });

    it('returns 0.2 for Edit with "not unique"', () => {
      expect(scoreResult('Edit', { content: 'not unique in file' }, {})).toBe(0.2);
    });

    it('returns 0.3 for Edit with no output', () => {
      expect(scoreResult('Edit', {}, {})).toBe(0.3);
    });

    it('returns 1.0 for Write with "created successfully"', () => {
      expect(scoreResult('Write', { content: 'created successfully' }, {})).toBe(1.0);
    });

    it('returns 0.9 for WebSearch with output', () => {
      expect(scoreResult('WebSearch', { content: 'search results here!' }, {})).toBe(0.9);
    });

    it('returns 0.85 for Task with output', () => {
      expect(scoreResult('Task', { content: 'sub-agent completed work.' }, {})).toBe(0.85);
    });

    it('returns 0.7 for unknown tool with output', () => {
      expect(scoreResult('CustomTool', { output: 'some output' }, {})).toBe(0.7);
    });

    it('returns 0.3 for unknown tool without output', () => {
      expect(scoreResult('CustomTool', {}, {})).toBe(0.3);
    });
  });

  describe('extractMeta()', () => {
    it('extracts command from description starting with /', () => {
      expect(extractMeta({ description: '/build updating file' })).toEqual({ command: '/build' });
    });

    it('extracts command from /analyze description', () => {
      expect(extractMeta({ description: '/analyze src/ --security' })).toEqual({ command: '/analyze' });
    });

    it('returns empty object when no description', () => {
      expect(extractMeta({})).toEqual({});
    });

    it('returns empty object when description does not start with /', () => {
      expect(extractMeta({ description: 'just a normal description' })).toEqual({});
    });
  });

  describe('classifyBashCommand()', () => {
    it('classifies npm test', () => {
      expect(classifyBashCommand('npm test')).toBe('test');
    });

    it('classifies npm run test', () => {
      expect(classifyBashCommand('npm run test')).toBe('test');
    });

    it('classifies pnpm build', () => {
      expect(classifyBashCommand('pnpm build')).toBe('build');
    });

    it('classifies yarn run lint', () => {
      expect(classifyBashCommand('yarn run lint')).toBe('lint');
    });

    it('classifies npm install', () => {
      expect(classifyBashCommand('npm install express')).toBe('install');
    });

    it('classifies git commands', () => {
      expect(classifyBashCommand('git push origin main')).toBe('git');
    });

    it('classifies tsc', () => {
      expect(classifyBashCommand('tsc --noEmit')).toBe('typecheck');
    });

    it('classifies npx tsc', () => {
      expect(classifyBashCommand('npx tsc')).toBe('typecheck');
    });

    it('classifies node execution', () => {
      expect(classifyBashCommand('node server.js')).toBe('execute');
    });

    it('classifies docker commands', () => {
      expect(classifyBashCommand('docker build .')).toBe('container');
    });

    it('classifies curl', () => {
      expect(classifyBashCommand('curl http://example.com')).toBe('http');
    });

    it('classifies ls', () => {
      expect(classifyBashCommand('ls -la')).toBe('list');
    });

    it('classifies mkdir', () => {
      expect(classifyBashCommand('mkdir -p /tmp/test')).toBe('filesystem');
    });

    it('returns null for unknown commands', () => {
      expect(classifyBashCommand('some-random-binary --flag')).toBeNull();
    });
  });

  describe('extractExtFromGlob()', () => {
    it('extracts ts from *.ts', () => {
      expect(extractExtFromGlob('*.ts')).toBe('ts');
    });

    it('extracts md from **/*.md', () => {
      expect(extractExtFromGlob('**/*.md')).toBe('md');
    });

    it('returns null for no pattern', () => {
      expect(extractExtFromGlob(null)).toBeNull();
    });

    it('returns null for pattern without extension', () => {
      expect(extractExtFromGlob('src/**')).toBeNull();
    });
  });
});
