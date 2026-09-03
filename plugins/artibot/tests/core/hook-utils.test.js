import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createErrorHandler,
  extractAgentId,
  extractAgentRole,
  extractExtension,
  extractFilePath,
  extractToolName,
  extractUserPromptFlagSurface,
  extractUserPromptText,
  getArtibotDataDir,
  getClaudeDir,
  getHomeDir,
  getStatePath,
  hasExtension,
  isArtibotRepo,
  isEnvEnabled,
  isSkippablePath,
  logHookError,
  matchesPathPattern,
  normalizePath,
} from '../../lib/core/hook-utils.js';

// -------------------------------------------------------------------------
// Path Validation
// -------------------------------------------------------------------------

describe('hook-utils / Path Validation', () => {
  describe('hasExtension()', () => {
    it('returns true when file has a matching extension (Set)', () => {
      const exts = new Set(['.js', '.ts', '.jsx']);
      expect(hasExtension('/src/app.js', exts)).toBe(true);
    });

    it('returns true when file has a matching extension (Array)', () => {
      expect(hasExtension('/src/app.ts', ['.js', '.ts'])).toBe(true);
    });

    it('returns false when extension does not match', () => {
      const exts = new Set(['.js', '.ts']);
      expect(hasExtension('/readme.md', exts)).toBe(false);
    });

    it('is case-insensitive', () => {
      const exts = new Set(['.js']);
      expect(hasExtension('/file.JS', exts)).toBe(true);
    });

    it('returns false for empty file path', () => {
      expect(hasExtension('', new Set(['.js']))).toBe(false);
    });

    it('returns false for null/undefined file path', () => {
      expect(hasExtension(null, new Set(['.js']))).toBe(false);
      expect(hasExtension(undefined, ['.js'])).toBe(false);
    });

    it('returns false for file with no extension', () => {
      expect(hasExtension('Makefile', new Set(['.js']))).toBe(false);
    });
  });

  describe('extractExtension()', () => {
    it('returns lowercase extension without dot', () => {
      expect(extractExtension('/src/app.js')).toBe('js');
    });

    it('returns lowercase for uppercase extensions', () => {
      expect(extractExtension('/file.TSX')).toBe('tsx');
    });

    it('returns null for files without extension', () => {
      expect(extractExtension('Makefile')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(extractExtension('')).toBeNull();
    });

    it('returns null for null/undefined', () => {
      expect(extractExtension(null)).toBeNull();
      expect(extractExtension(undefined)).toBeNull();
    });
  });

  describe('matchesPathPattern()', () => {
    it('returns true when path matches any pattern', () => {
      const patterns = [/\.env$/i, /credentials/i];
      expect(matchesPathPattern('.env', patterns)).toBe(true);
      expect(matchesPathPattern('credentials.json', patterns)).toBe(true);
    });

    it('returns false when no pattern matches', () => {
      const patterns = [/\.env$/i];
      expect(matchesPathPattern('app.js', patterns)).toBe(false);
    });

    it('returns false for empty/null path', () => {
      expect(matchesPathPattern('', [/test/])).toBe(false);
      expect(matchesPathPattern(null, [/test/])).toBe(false);
    });

    it('returns false for empty patterns array', () => {
      expect(matchesPathPattern('/file.js', [])).toBe(false);
    });
  });

  describe('normalizePath()', () => {
    it('replaces backslashes with forward slashes', () => {
      expect(normalizePath('C:\\Users\\test\\file.js')).toBe('C:/Users/test/file.js');
    });

    it('leaves forward slashes unchanged', () => {
      expect(normalizePath('/usr/local/bin')).toBe('/usr/local/bin');
    });

    it('handles mixed separators', () => {
      expect(normalizePath('src\\lib/core\\file.js')).toBe('src/lib/core/file.js');
    });
  });

  describe('isSkippablePath()', () => {
    it('returns true for node_modules paths', () => {
      expect(isSkippablePath('/project/node_modules/pkg/index.js')).toBe(true);
    });

    it('returns true for .git paths', () => {
      expect(isSkippablePath('/project/.git/config')).toBe(true);
    });

    it('returns true for .lock files', () => {
      expect(isSkippablePath('yarn.lock')).toBe(true);
    });

    it('returns true for -lock.json files', () => {
      expect(isSkippablePath('package-lock.json')).toBe(true);
    });

    it('returns false for regular source files', () => {
      expect(isSkippablePath('/src/app.js')).toBe(false);
    });

    it('handles Windows paths with backslashes', () => {
      expect(isSkippablePath('C:\\project\\node_modules\\pkg\\index.js')).toBe(true);
    });
  });
});

// -------------------------------------------------------------------------
// Error Logging
// -------------------------------------------------------------------------

describe('hook-utils / Error Logging', () => {
  let stderrSpy;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('logHookError()', () => {
    it('writes error with artibot prefix', () => {
      logHookError('pre-bash', 'command failed');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(stderrSpy.mock.calls[0][0]).toBe('[artibot:pre-bash] command failed\n');
    });

    it('includes cause.message when cause is an Error', () => {
      logHookError('session-end', 'failed', new Error('disk full'));
      expect(stderrSpy.mock.calls[0][0]).toBe('[artibot:session-end] failed: disk full\n');
    });

    it('includes string cause directly', () => {
      logHookError('hook', 'error', 'timeout');
      expect(stderrSpy.mock.calls[0][0]).toBe('[artibot:hook] error: timeout\n');
    });

    it('omits detail for null cause', () => {
      logHookError('hook', 'error', null);
      expect(stderrSpy.mock.calls[0][0]).toBe('[artibot:hook] error\n');
    });

    it('omits detail for undefined cause', () => {
      logHookError('hook', 'error', undefined);
      expect(stderrSpy.mock.calls[0][0]).toBe('[artibot:hook] error\n');
    });

    it('omits detail when no cause provided', () => {
      logHookError('hook', 'simple error');
      expect(stderrSpy.mock.calls[0][0]).toBe('[artibot:hook] simple error\n');
    });
  });

  describe('createErrorHandler()', () => {
    it('returns a function that logs the error', () => {
      const handler = createErrorHandler('pre-write');
      handler(new Error('write failed'));
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(stderrSpy.mock.calls[0][0]).toBe('[artibot:pre-write] write failed\n');
    });

    it('calls writeStdout with block decision when configured', () => {
      const mockWriteStdout = vi.fn();
      const handler = createErrorHandler('pre-bash', {
        writeStdout: mockWriteStdout,
        blockReason: 'Safety check failed',
      });
      handler(new Error('parse error'));
      expect(mockWriteStdout).toHaveBeenCalledWith({
        decision: 'block',
        reason: 'Safety check failed',
      });
    });

    it('does not call writeStdout without blockReason', () => {
      const mockWriteStdout = vi.fn();
      const handler = createErrorHandler('hook', { writeStdout: mockWriteStdout });
      handler(new Error('err'));
      expect(mockWriteStdout).not.toHaveBeenCalled();
    });

    it('calls process.exit(0) when exit option is true', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
      const handler = createErrorHandler('hook', { exit: true });
      handler(new Error('fatal'));
      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
    });

    it('does not call process.exit by default', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
      const handler = createErrorHandler('hook');
      handler(new Error('non-fatal'));
      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });

    it('handles errors without message property', () => {
      const handler = createErrorHandler('hook');
      handler('string error');
      expect(stderrSpy.mock.calls[0][0]).toBe('[artibot:hook] string error\n');
    });
  });
});

// -------------------------------------------------------------------------
// Environment Checks
// -------------------------------------------------------------------------

describe('hook-utils / Environment Checks', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getHomeDir()', () => {
    it('returns USERPROFILE when set', () => {
      process.env.USERPROFILE = 'C:\\Users\\test';
      process.env.HOME = '/home/test';
      expect(getHomeDir()).toBe('C:\\Users\\test');
    });

    it('falls back to HOME when USERPROFILE is not set', () => {
      delete process.env.USERPROFILE;
      process.env.HOME = '/home/test';
      expect(getHomeDir()).toBe('/home/test');
    });

    it('falls back to os.homedir() when neither is set (never empty)', () => {
      // Unified with platform.getHomeDir: env-stripped hook spawns must still
      // resolve an absolute home so getClaudeDir() is never a relative `.claude`.
      delete process.env.USERPROFILE;
      delete process.env.HOME;
      const home = getHomeDir();
      expect(typeof home).toBe('string');
      expect(home.length).toBeGreaterThan(0);
    });
  });

  describe('getClaudeDir()', () => {
    it('returns path joining home dir with .claude', () => {
      process.env.USERPROFILE = 'C:\\Users\\test';
      const result = getClaudeDir();
      expect(result).toContain('.claude');
      expect(result).toContain('test');
    });
  });

  describe('getArtibotDataDir()', () => {
    it('returns path joining claude dir with artibot', () => {
      process.env.USERPROFILE = 'C:\\Users\\test';
      const result = getArtibotDataDir();
      expect(result).toContain('.claude');
      expect(result).toContain('artibot');
    });
  });

  describe('getStatePath()', () => {
    it('returns path to artibot-state.json', () => {
      process.env.USERPROFILE = 'C:\\Users\\test';
      const result = getStatePath();
      expect(result).toContain('artibot-state.json');
    });
  });

  describe('isEnvEnabled()', () => {
    it('returns true for value "1"', () => {
      process.env.TEST_VAR = '1';
      expect(isEnvEnabled('TEST_VAR')).toBe(true);
    });

    it('returns true for value "true"', () => {
      process.env.TEST_VAR = 'true';
      expect(isEnvEnabled('TEST_VAR')).toBe(true);
    });

    it('returns false for value "0"', () => {
      process.env.TEST_VAR = '0';
      expect(isEnvEnabled('TEST_VAR')).toBe(false);
    });

    it('returns false for value "false"', () => {
      process.env.TEST_VAR = 'false';
      expect(isEnvEnabled('TEST_VAR')).toBe(false);
    });

    it('returns false for unset variable', () => {
      delete process.env.TEST_VAR;
      expect(isEnvEnabled('TEST_VAR')).toBe(false);
    });
  });
});

// -------------------------------------------------------------------------
// Hook Input Extraction
// -------------------------------------------------------------------------

describe('hook-utils / Hook Input Extraction', () => {
  describe('extractFilePath()', () => {
    it('extracts file_path from tool_input', () => {
      const data = { tool_input: { file_path: '/src/app.js' } };
      expect(extractFilePath(data)).toBe('/src/app.js');
    });

    it('falls back to path from tool_input', () => {
      const data = { tool_input: { path: '/src/app.js' } };
      expect(extractFilePath(data)).toBe('/src/app.js');
    });

    it('prefers file_path over path', () => {
      const data = { tool_input: { file_path: '/a.js', path: '/b.js' } };
      expect(extractFilePath(data)).toBe('/a.js');
    });

    it('returns empty string for missing data', () => {
      expect(extractFilePath(null)).toBe('');
      expect(extractFilePath({})).toBe('');
      expect(extractFilePath({ tool_input: {} })).toBe('');
    });
  });

  describe('extractToolName()', () => {
    it('extracts tool_name', () => {
      expect(extractToolName({ tool_name: 'Edit' })).toBe('Edit');
    });

    it('falls back to tool', () => {
      expect(extractToolName({ tool: 'Write' })).toBe('Write');
    });

    it('falls back to camelCase toolName', () => {
      expect(extractToolName({ toolName: 'Bash' })).toBe('Bash');
    });

    it('falls back to nested toolUse.name', () => {
      expect(extractToolName({ toolUse: { name: 'Read' } })).toBe('Read');
    });

    it('falls back to nested tool_use.name', () => {
      expect(extractToolName({ tool_use: { name: 'Grep' } })).toBe('Grep');
    });

    it('returns null for missing data', () => {
      expect(extractToolName(null)).toBeNull();
      expect(extractToolName(undefined)).toBeNull();
      expect(extractToolName({})).toBeNull();
    });

    it('returns null for non-object payloads', () => {
      expect(extractToolName('Bash')).toBeNull();
      expect(extractToolName(42)).toBeNull();
    });
  });

  // Regression cover for the UserPromptSubmit key mismatch: five of the six
  // contributors read `user_prompt`/`content` only, so with the host's real
  // key (`prompt`, measured against Claude Code 2.1.259) they all saw '' and
  // silently no-opped for a whole release.
  describe('extractUserPromptText()', () => {
    it('reads the host key `prompt`', () => {
      expect(extractUserPromptText({ prompt: 'hello' })).toBe('hello');
    });

    it('prefers the dispatcher-written user_prompt over the host prompt', () => {
      expect(extractUserPromptText({ prompt: 'raw', user_prompt: 'rewritten' }))
        .toBe('rewritten');
    });

    // A `||` chain would fall through to `prompt` here and undo a deliberate
    // blank-out by the rewriter — the exact bug the typeof check prevents.
    it('preserves an empty-string rewrite rather than falling back', () => {
      expect(extractUserPromptText({ prompt: 'raw', user_prompt: '' })).toBe('');
    });

    it('falls back to the legacy content key', () => {
      expect(extractUserPromptText({ content: 'legacy' })).toBe('legacy');
    });

    it('ignores keys that no UserPromptSubmit payload carries', () => {
      expect(extractUserPromptText({ userPrompt: 'y', message: 'm', text: 't' }))
        .toBe('');
    });

    it('returns empty string for non-object input', () => {
      expect(extractUserPromptText(null)).toBe('');
      expect(extractUserPromptText(undefined)).toBe('');
      expect(extractUserPromptText(42)).toBe('');
      expect(extractUserPromptText({})).toBe('');
    });

    it('ignores non-string values under a recognised key', () => {
      expect(extractUserPromptText({ user_prompt: 42, prompt: 'ok' })).toBe('ok');
    });
  });

  // Opt-out flags must survive the rewriter. `user-prompt-handler` strips
  // `--no-team` and the dispatcher publishes the stripped text on
  // `user_prompt`, so a hook testing its regex against the classify-value
  // never sees the flag the user typed.
  describe('extractUserPromptFlagSurface()', () => {
    it('carries the flag from the untouched host key when the rewrite dropped it', () => {
      const surface = extractUserPromptFlagSurface({
        prompt: 'ship the feature --no-team',
        user_prompt: 'ship the feature',
      });
      expect(surface).toMatch(/--no-team\b/);
    });

    it('also carries a flag that only the rewritten value holds', () => {
      // A direct handler call with no rewriter in front of it. Reading only the
      // "original" would miss this, which is why the surface is a union.
      expect(extractUserPromptFlagSurface({ user_prompt: 'x --no-team' }))
        .toMatch(/--no-team\b/);
    });

    it('joins with a newline so \\b cannot fuse two values into a false match', () => {
      // The split point is chosen so the two joins actually DISAGREE:
      //   concat  -> 'a --no-team b'  => /--no-team\b/ MATCHES (the false positive)
      //   newline -> 'a --no-\nteam b' => no match (what this function must do)
      // A split like 'a --no' + 'team b' would be non-discriminating: bare
      // concat gives '--noteam', which has no hyphen and fails the regex
      // anyway, so the assertion would pass no matter how the values were
      // joined and would prove nothing.
      const parts = { user_prompt: 'a --no-', prompt: 'team b' };
      const surface = extractUserPromptFlagSurface(parts);

      expect(surface).toBe('a --no-\nteam b');
      expect(/--no-team\b/.test(surface)).toBe(false);
      // Control: the rejected implementation really would have matched here.
      expect(/--no-team\b/.test(parts.user_prompt + parts.prompt)).toBe(true);
    });

    it('deduplicates identical values and drops empties', () => {
      expect(extractUserPromptFlagSurface({ user_prompt: 'same', prompt: 'same' }))
        .toBe('same');
      expect(extractUserPromptFlagSurface({ user_prompt: '', prompt: 'only' }))
        .toBe('only');
    });

    it('returns empty string for non-object input', () => {
      expect(extractUserPromptFlagSurface(null)).toBe('');
      expect(extractUserPromptFlagSurface(42)).toBe('');
      expect(extractUserPromptFlagSurface({})).toBe('');
    });
  });

  describe('extractAgentId()', () => {
    it('extracts agent_id', () => {
      expect(extractAgentId({ agent_id: 'a1' })).toBe('a1');
    });

    it('falls back to subagent_id', () => {
      expect(extractAgentId({ subagent_id: 's1' })).toBe('s1');
    });

    it('falls back to name', () => {
      expect(extractAgentId({ name: 'test-agent' })).toBe('test-agent');
    });

    it('returns "unknown" for missing data', () => {
      expect(extractAgentId(null)).toBe('unknown');
      expect(extractAgentId({})).toBe('unknown');
    });
  });

  describe('extractAgentRole()', () => {
    it('extracts role', () => {
      expect(extractAgentRole({ role: 'architect' })).toBe('architect');
    });

    it('falls back to agent_type', () => {
      expect(extractAgentRole({ agent_type: 'qa' })).toBe('qa');
    });

    it('returns default role for missing data', () => {
      expect(extractAgentRole(null)).toBe('teammate');
      expect(extractAgentRole({})).toBe('teammate');
    });

    it('uses custom default role', () => {
      expect(extractAgentRole({}, 'worker')).toBe('worker');
    });
  });
});

// -------------------------------------------------------------------------
// v4.7.4: isArtibotRepo source-of-truth (replaces duplicated impls in
// dev-verify-gate.js / stop-review-gate.js / pre-write-guard.js)
// -------------------------------------------------------------------------

describe('hook-utils / isArtibotRepo', () => {
  let workdir;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'artibot-hu-'));
  });

  afterEach(() => {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('detects monorepo root via plugins/artibot/CLAUDE.md', () => {
    mkdirSync(path.join(workdir, 'plugins', 'artibot'), { recursive: true });
    writeFileSync(path.join(workdir, 'plugins', 'artibot', 'CLAUDE.md'), '# stub');
    expect(isArtibotRepo(workdir)).toBe(true);
  });

  it('detects plugin directory directly via artibot.config.json', () => {
    writeFileSync(path.join(workdir, 'artibot.config.json'), '{}');
    expect(isArtibotRepo(workdir)).toBe(true);
  });

  it('detects when both signals are present', () => {
    mkdirSync(path.join(workdir, 'plugins', 'artibot'), { recursive: true });
    writeFileSync(path.join(workdir, 'plugins', 'artibot', 'CLAUDE.md'), '# stub');
    writeFileSync(path.join(workdir, 'artibot.config.json'), '{}');
    expect(isArtibotRepo(workdir)).toBe(true);
  });

  it('returns false when neither signal is present', () => {
    writeFileSync(path.join(workdir, 'package.json'), '{"name":"unrelated"}');
    expect(isArtibotRepo(workdir)).toBe(false);
  });

  it('returns false defensively for empty / null cwd (and no process fallback hit)', () => {
    expect(isArtibotRepo('')).toBe(false);
    // Argument explicitly null still returns false because the helper checks
    // the supplied dir; it falls back to process.cwd() only when the arg is
    // missing. Pass empty string above to exercise the !dir branch.
    expect(isArtibotRepo(null)).toBe(false);
  });

  it('falls back to process.cwd() when called with no argument', () => {
    const orig = process.cwd();
    try {
      process.chdir(workdir);
      // No markers in workdir → false even via fallback.
      expect(isArtibotRepo()).toBe(false);
      writeFileSync(path.join(workdir, 'artibot.config.json'), '{}');
      expect(isArtibotRepo()).toBe(true);
    } finally {
      process.chdir(orig);
    }
  });
});
