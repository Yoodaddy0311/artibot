import { describe, expect, it } from 'vitest';

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
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const SKIP_TOOLS = new Set([
  'TodoRead', 'TodoWrite', 'TaskList', 'TaskGet', 'TaskUpdate',
  'TaskCreate', 'SendMessage', 'TeamCreate', 'TeamDelete',
  // v4.6.4: orchestration-only tools that previously locked at 0.3
  'AskUserQuestion', 'ExitPlanMode', 'Skill',
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
    case 'Agent':
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

  // v4.6.4: MCP tools score via exit code + stderr (Bash-style), not output length.
  if (toolName.startsWith('mcp__')) {
    const exitCode = result.exit_code ?? result.exitCode;
    const stderr = result.stderr || '';
    if (exitCode !== 0 && exitCode !== undefined) return 0.1;
    if (!output || output.length < MIN_SUBSTANTIVE_LENGTH) {
      return stderr ? 0.4 : 0.7;
    }
    if (stderr && stderr.length > 50) return 0.7;
    return 0.95;
  }

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
    case 'Agent':
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

// Exact copy of tool-tracker.js extractToolResult — resolves the tool output
// from a Claude Code PostToolUse payload across all known field aliases.
function extractToolResult(hookData) {
  const failure = hookData?.error ?? hookData?.tool_error;
  if (typeof failure === 'string' && failure) return { error: failure };
  if (failure && typeof failure === 'object') {
    return { ...failure, error: failure.message || true };
  }

  const raw = hookData?.tool_response
    ?? hookData?.tool_result
    ?? hookData?.tool_output
    ?? hookData?.output
    ?? {};
  if (typeof raw === 'string') return { output: raw };
  if (raw && typeof raw === 'object') return raw;
  return {};
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

    // v4.6.4 regression: orchestration-only tools must be skipped to avoid
    // polluting GRPO weights with apparent "20% success" signals from the
    // default scoring branch.
    it('includes AskUserQuestion (v4.6.4)', () => {
      expect(SKIP_TOOLS.has('AskUserQuestion')).toBe(true);
    });

    it('includes ExitPlanMode (v4.6.4)', () => {
      expect(SKIP_TOOLS.has('ExitPlanMode')).toBe(true);
    });

    it('includes Skill (v4.6.4)', () => {
      expect(SKIP_TOOLS.has('Skill')).toBe(true);
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

    // Design follow-up 4: the host renamed the spawn tool Task -> Agent, so the
    // branch that reads `subagent_type` had been falling through to `default`
    // and recording every delegation as `use:agent:tool`. Both spellings are
    // handled; the old one is kept so an older host does not regress.
    it('builds context for Agent tool (the current host spelling of Task)', () => {
      expect(buildContext('Agent', { subagent_type: 'code-reviewer' }))
        .toBe('delegate:code-reviewer:subagent');
      expect(buildContext('Agent', { subagent_type: 'artibot:tdd-guide' }))
        .toBe('delegate:artibot:tdd-guide:subagent');
    });

    it('builds context for Agent tool with type fallback and with neither key', () => {
      expect(buildContext('Agent', { type: 'security' })).toBe('delegate:security:subagent');
      expect(buildContext('Agent', {})).toBe('delegate:generic:subagent');
      // The regression this closes: before follow-up 4 an Agent payload hit the
      // default branch and lost the agent type entirely.
      expect(buildContext('Agent', { subagent_type: 'code-reviewer' })).not.toBe('use:agent:tool');
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

    it('returns 0.85 for Agent with output and 0.3 without (same rule as Task)', () => {
      expect(scoreResult('Agent', { content: 'sub-agent completed work.' }, {})).toBe(0.85);
      expect(scoreResult('Agent', {}, {})).toBe(0.3);
    });

    it('returns 0.7 for unknown tool with output', () => {
      expect(scoreResult('CustomTool', { output: 'some output' }, {})).toBe(0.7);
    });

    it('returns 0.3 for unknown tool without output', () => {
      expect(scoreResult('CustomTool', {}, {})).toBe(0.3);
    });

    // v4.6.4 regression: MCP tools previously locked at 0.3 in default branch.
    describe('MCP tool branch (mcp__*)', () => {
      it('returns 0.95 for mcp__playwright__evaluate with substantive output', () => {
        const result = { content: 'a'.repeat(60), exit_code: 0 };
        expect(scoreResult('mcp__playwright__evaluate', result, {})).toBe(0.95);
      });

      it('returns 0.7 for mcp__playwright__screenshot with empty output but no error', () => {
        // Side-effect calls (e.g., screenshot capture to file) often return empty content
        expect(scoreResult('mcp__playwright__screenshot', {}, {})).toBe(0.7);
      });

      it('returns 0.4 for mcp__* with empty output and stderr present', () => {
        expect(scoreResult('mcp__server__call', { stderr: 'minor warning' }, {})).toBe(0.4);
      });

      it('returns 0.1 for mcp__* with non-zero exit code', () => {
        expect(scoreResult('mcp__server__call', { exit_code: 1, content: 'err' }, {})).toBe(0.1);
      });

      it('returns 0.7 for mcp__* with substantive output but long stderr', () => {
        const result = { content: 'a'.repeat(60), stderr: 'w'.repeat(60), exit_code: 0 };
        expect(scoreResult('mcp__some__tool', result, {})).toBe(0.7);
      });

      it('returns 0.0 when mcp__* result has explicit is_error', () => {
        expect(scoreResult('mcp__server__call', { is_error: true }, {})).toBe(0.0);
      });
    });
  });

  // Wiring regression guard (Track T3 ①): Claude Code's PostToolUse payload
  // carries tool output under `tool_response`, NOT `tool_result`. Reading only
  // `tool_result` starved scoreResult of output/exit_code and collapsed every
  // score to a per-tool constant. These tests pin the field resolution so a
  // silent regression to `tool_result`-only fails CI.
  describe('extractToolResult() payload wiring', () => {
    it('reads canonical tool_response object', () => {
      const r = extractToolResult({ tool_response: { content: 'hello world data' } });
      expect(scoreResult('Read', r, {})).toBe(1.0);
    });

    it('normalises a string tool_response into { output }', () => {
      const r = extractToolResult({ tool_response: 'some stdout text' });
      expect(r).toEqual({ output: 'some stdout text' });
      expect(getResultContent(r)).toBe('some stdout text');
    });

    it('falls back to legacy tool_result', () => {
      const r = extractToolResult({ tool_result: { exit_code: 1 } });
      expect(scoreResult('Bash', r, {})).toBe(0.1);
    });

    it('falls back to tool_output then output', () => {
      expect(extractToolResult({ tool_output: { content: 'x' } })).toEqual({ content: 'x' });
      expect(extractToolResult({ output: { content: 'y' } })).toEqual({ content: 'y' });
    });

    it('returns {} for empty / missing payloads (no crash)', () => {
      expect(extractToolResult({})).toEqual({});
      expect(extractToolResult(null)).toEqual({});
      expect(extractToolResult({ tool_response: 123 })).toEqual({});
    });

    it('maps a top-level `error` string to { error } — the PostToolUseFailure shape', () => {
      const r = extractToolResult({ error: 'Exit code 125\nunknown flag: --bogus' });
      expect(r).toEqual({ error: 'Exit code 125\nunknown flag: --bogus' });
      expect(scoreResult('Bash', r, {})).toBe(0.0);
    });

    it('TRAP GUARD: a failure must NOT be normalised into { output } (would score 1.0)', () => {
      // The obvious "just add ?? hookData.error to the chain" fix routes the
      // string through the { output: … } normaliser. scoreResult's 0.0 branch
      // tests result.error, so the failure would score a perfect 1.0 again.
      // This test pins the key name, which is the entire substance of the fix.
      const r = extractToolResult({ error: 'Exit code 1\ncd: nope: No such file or directory' });
      expect(r.output).toBeUndefined();
      expect(r.error).toBeTruthy();
      expect(scoreResult('Bash', r, {})).toBe(0.0);
      expect(scoreResult('Bash', { output: 'Exit code 1\ncd: nope' }, {})).toBe(1.0); // the wrong shape
    });

    it('handles an object-shaped error payload', () => {
      const r = extractToolResult({ error: { message: 'boom', code: 'EBOOM' } });
      expect(r.error).toBe('boom');
      expect(scoreResult('Bash', r, {})).toBe(0.0);
    });

    // Same failure family as the TRAP GUARD above: a falsy value parked on
    // `error` sails through scoreResult's `if (result.error || ...)` and the
    // failure scores a perfect 1.0 again. `??` only substitutes null/undefined,
    // so an empty message stayed empty; `||` covers every falsy message.
    it.each([
      ['empty string', ''],
      ['zero', 0],
      ['false', false],
    ])('object-shaped error with a %s message still scores 0.0', (_label, message) => {
      const r = extractToolResult({ error: { message } });
      expect(r.error).toBeTruthy();
      expect(scoreResult('Bash', r, {})).toBe(0.0);
    });

    it('object-shaped error preserves a real message (|| does not clobber it)', () => {
      expect(extractToolResult({ error: { message: 'real failure text' } }).error)
        .toBe('real failure text');
    });

    it('reads the tool_error alias', () => {
      expect(scoreResult('Bash', extractToolResult({ tool_error: 'failed' }), {})).toBe(0.0);
    });

    it('ignores an empty-string error and falls through to tool_response', () => {
      const r = extractToolResult({ error: '', tool_response: { exit_code: 0 } });
      expect(scoreResult('Bash', r, {})).toBe(1.0);
    });

    it('success payloads are unaffected (no error key present)', () => {
      const r = extractToolResult({ tool_response: { exit_code: 0, stdout: 'ok' } });
      expect(r.error).toBeUndefined();
      expect(scoreResult('Bash', r, {})).toBe(1.0);
    });

    it('regression: tool_response Bash exit_code now scores (was constant 1.0)', () => {
      // Pre-fix, tool_result was always {} → exit_code undefined → always 1.0.
      // Post-fix, a real failing Bash result scores 0.1.
      const failing = extractToolResult({ tool_response: { exit_code: 2, stderr: 'boom' } });
      expect(scoreResult('Bash', failing, {})).toBe(0.1);
      const passing = extractToolResult({ tool_response: { exit_code: 0 } });
      expect(scoreResult('Bash', passing, {})).toBe(1.0);
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

  // v4.7.3 regression guard (perf-auditor A1.4 / issue-scanner A2#1):
  // Tools hitting the scoreResult default branch get locked at 0.7/0.3 which
  // pollutes GRPO weights. The tests below pin scoring outcomes for tool
  // namespaces that recur in real sessions, and assert SKIP_TOOLS invariants
  // so a silent score-shift fails CI rather than reaching production.
  describe('scoreResult default-branch regression guard', () => {
    it('agent-namespaced tools resolve to the default branch (0.7 / 0.3)', () => {
      expect(scoreResult('agent__custom_tool', { output: 'ok' }, {})).toBe(0.7);
      expect(scoreResult('agent__custom_tool', {}, {})).toBe(0.3);
      expect(SKIP_TOOLS.has('agent__custom_tool')).toBe(false);
    });

    it('team__create resolves to the default branch (0.7 / 0.3)', () => {
      expect(scoreResult('team__create', { output: 'team-ok' }, {})).toBe(0.7);
      expect(scoreResult('team__create', {}, {})).toBe(0.3);
      expect(SKIP_TOOLS.has('team__create')).toBe(false);
    });

    it('mcp__server__method routes to MCP branch (0.95), NOT default 0.3', () => {
      const score = scoreResult(
        'mcp__server__method',
        { content: 'a'.repeat(60), exit_code: 0, stderr: '' },
        {},
      );
      expect(score).toBe(0.95);
    });

    it('AskUserQuestion is in SKIP_TOOLS (orchestration primitive)', () => {
      expect(SKIP_TOOLS.has('AskUserQuestion')).toBe(true);
    });

    it('Skill is in SKIP_TOOLS (orchestration primitive)', () => {
      expect(SKIP_TOOLS.has('Skill')).toBe(true);
    });

    // Meta-test: every score of 0.3 produced by scoreResult must come from
    // either an explicit-cased fallback (Edit/Write/Task with no output) or
    // the default branch with no output. Orchestration primitives MUST be
    // routed to SKIP_TOOLS before they ever reach scoreResult.
    it('meta: every 0.3 score path is justified (explicit case or default)', () => {
      expect(scoreResult('Edit', {}, {})).toBe(0.3);
      expect(scoreResult('Write', {}, {})).toBe(0.3);
      expect(scoreResult('Task', {}, {})).toBe(0.3);
      expect(scoreResult('GenericTool', {}, {})).toBe(0.3);
      for (const skip of ['AskUserQuestion', 'ExitPlanMode', 'Skill', 'SendMessage', 'TeamCreate']) {
        expect(SKIP_TOOLS.has(skip)).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: REAL captured payloads → the REAL tool-tracker.js
//
// Every other test in this file re-implements tool-tracker's internals (see the
// file header: vite cannot parse the real module). Those copies can drift from
// the source and still pass — which is exactly how a failed Bash call came to
// score a perfect 1.0 unnoticed. This block spawns the actual script with an
// isolated HOME and asserts what it really persists, so it cannot drift.
//
// Fixture payloads were captured live on 2026-08-10 by dumping raw hook stdin.
// Only identifying fields are redacted (session_id, prompt_id, tool_use_id,
// transcript_path, cwd, home paths inside commands). The load-bearing shape is
// untouched: failures carry their text at top-level `error` with NO
// `tool_response` key; successes carry `tool_response`.
// ---------------------------------------------------------------------------
describe('real captured payloads -> real tool-tracker.js (integration)', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const TRACKER = path.resolve(HERE, '..', '..', 'scripts', 'hooks', 'tool-tracker.js');
  const FIXTURE = path.resolve(HERE, '..', 'fixtures', 'tool-tracker-hook-payloads.jsonl');

  /**
   * Run the real hook against one payload in a throwaway HOME.
   * @param {string} rawPayload
   * @returns {Array<{context: string, score: number}>}
   */
  function runTracker(rawPayload) {
    const home = mkdtempSync(path.join(tmpdir(), 'tt-int-'));
    try {
      execFileSync(process.execPath, [TRACKER, 'failure'], {
        input: rawPayload,
        env: { ...process.env, USERPROFILE: home, HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const store = path.join(home, '.claude', 'artibot', 'tool-history.json');
      if (!existsSync(store)) return [];
      const parsed = JSON.parse(readFileSync(store, 'utf-8'));
      return Object.entries(parsed.contexts || {}).flatMap(([context, rows]) =>
        rows.map((r) => ({ context, score: r.score })));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  const payloads = readFileSync(FIXTURE, 'utf-8')
    .trim().split('\n').map((l) => ({ raw: l, parsed: JSON.parse(l) }));
  const failures = payloads.filter((p) => 'error' in p.parsed);
  const successes = payloads.filter((p) => !('error' in p.parsed));

  it('fixture holds both captured failures and captured successes', () => {
    expect(failures.length).toBeGreaterThanOrEqual(3);
    expect(successes.length).toBeGreaterThanOrEqual(2);
    // Pin the property the fix depends on: real failures carry no tool_response.
    for (const f of failures) expect('tool_response' in f.parsed).toBe(false);
  });

  // Each case spawns a real node process, so CI runs one payload per direction
  // rather than all five — enough to catch drift between this file's mirrored
  // helpers and the real module. The remaining fixture rows are exercised by the
  // shape assertion above and by scratchpad/score-harness.mjs during manual
  // verification.
  //
  // These spawns used to take ~5s each: the hook idled out the learner's 5000ms
  // write debounce before exiting. tool-tracker.js now flushes explicitly, so a
  // run is ~150ms — see the 'persists within its dispatcher timeout' block below
  // for why that delay was a production bug and not just slow tests.
  const [firstFailure] = failures;
  const [firstSuccess] = successes;

  it(`scores real captured failure (${firstFailure.parsed.tool_input.command.slice(0, 30)}) as 0.0`, () => {
    const rows = runTracker(firstFailure.raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(0.0);
  });

  it(`keeps real captured success (${firstSuccess.parsed.tool_input.command.slice(0, 30)}) at 1.0`, () => {
    const rows = runTracker(firstSuccess.raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Regression: the hook must persist within the budget the dispatcher gives it.
//
// tool-learner.recordUsage() only marks history dirty and arms a 5000ms flush
// timer. _posttooluse-dispatcher.js spawns this hook and SIGTERMs it at the
// `tool-tracker` timeout in hooks/dispatch-table.json (3000ms), so the timer
// never fired and NOTHING was ever written in production — measured 2026-08-10:
// SIGTERM@3000ms left no tool-history.json at all.
//
// The budget is read from dispatch-table.json rather than hardcoded, so raising
// or lowering the timeout re-tests the real invariant instead of a stale number.
// ---------------------------------------------------------------------------
describe('tool-tracker persists within its dispatcher timeout', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const TRACKER = path.resolve(HERE, '..', '..', 'scripts', 'hooks', 'tool-tracker.js');
  const TABLE = path.resolve(HERE, '..', '..', 'hooks', 'dispatch-table.json');

  /** The exact timeout production gives this hook. */
  function dispatcherTimeoutMs() {
    const table = JSON.parse(readFileSync(TABLE, 'utf-8'));
    const handler = table.slots.PostToolUse.handlers
      .find((h) => h.name === 'tool-tracker');
    return handler.timeoutMs;
  }

  /**
   * Spawn the real hook and SIGTERM it exactly like the dispatcher does.
   * @param {number} killAfterMs
   * @returns {Promise<{written: boolean, signal: string|null}>}
   */
  function runUnderTimeout(killAfterMs) {
    const home = mkdtempSync(path.join(tmpdir(), 'tt-timeout-'));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [TRACKER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, USERPROFILE: home, HOME: home },
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }, killAfterMs);
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'resolveModel', output_mode: 'content' },
        tool_response: { mode: 'content', numFiles: 0, filenames: [], content: '', numLines: 0 },
        session_id: 'timeout-regression',
      }));
      child.on('exit', (_code, signal) => {
        clearTimeout(timer);
        const store = path.join(home, '.claude', 'artibot', 'tool-history.json');
        const written = existsSync(store);
        rmSync(home, { recursive: true, force: true });
        resolve({ written, signal });
      });
    });
  }

  it('reads a real timeout from the dispatch table', () => {
    const ms = dispatcherTimeoutMs();
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
  });

  it('writes tool-history.json before the dispatcher kills it', async () => {
    const { written, signal } = await runUnderTimeout(dispatcherTimeoutMs());
    // Exiting on its own (no signal) is the fix working: the explicit flush
    // clears the armed timer, so the process does not idle out the debounce.
    expect(signal).toBeNull();
    expect(written).toBe(true);
  }, 20000);
});
