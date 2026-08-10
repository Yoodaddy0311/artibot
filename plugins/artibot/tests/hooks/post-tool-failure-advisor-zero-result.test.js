import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WP-3 B-2 — Bash channel of the zero-result guard.
 *
 * `grep`/`rg` exiting 1 means "no lines selected". When the searched token is
 * an identifier, that is the same "0 hits therefore absent" trap the Grep/Glob
 * tool guard (scripts/hooks/zero-result-guard.js) covers, arriving through a
 * different door.
 *
 * Reachability, measured: only Bash EXECUTION failures reach this hook at all
 * (3/38 = 7.9% of failures, baseline 2026-08-10T00:47Z). A grep wrapped in
 * `|| true` or `|| echo none` exits 0 and never arrives here.
 *
 * Split out of post-tool-failure-advisor.test.js purely for the 800-line file
 * cap; it exercises the same module. No vi.mock here — these tests want the
 * real utils, and the hook's direct-run guard makes importing it safe.
 */

const {
  buildAdvice,
  matchZeroResultScope,
  parseGrepInvocation,
  residualAfterExitLine,
  selectAdvice,
} = await import('../../scripts/hooks/post-tool-failure-advisor.js');

// Verbatim from the same 2026-08-10 corpus dump used by the sibling suite.
const CORPUS = {
  cdRelative: 'Exit code 1\n/usr/bin/bash: line 1: cd: plugins/artibot: No such file or directory',
  nodeEnoent:
    'Exit code 1\nnode:fs:441\n    return binding.readFileUtf8(path, stringToFlags(options.flag));\n'
    + "\nError: ENOENT: no such file or directory, open 'C:\\tmp\\handoff.md'",
  gitDiffExit1:
    'Exit code 1\n plugins/artibot/package.json                       |  2 +-\n'
    + ' plugins/artibot/rules/agent-coordination.md        | 11 +++---',
};

let root;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-advisor-zr-'));
  mkdirSync(path.join(root, 'plugins', 'artibot'), { recursive: true });
  writeFileSync(path.join(root, 'plugins', 'artibot', 'x.md'), '# doc\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('residualAfterExitLine', () => {
  it('strips the leading "Exit code N" line', () => {
    expect(residualAfterExitLine('Exit code 1')).toBe('');
    expect(residualAfterExitLine('Exit code 1\n')).toBe('');
    expect(residualAfterExitLine('Exit code 1\n\n  ')).toBe('');
  });

  it('keeps whatever the command actually printed', () => {
    expect(residualAfterExitLine(CORPUS.gitDiffExit1)).toContain('plugins/artibot/package.json');
    expect(residualAfterExitLine(CORPUS.nodeEnoent)).toContain('ENOENT');
  });

  it('returns the whole text when there is no exit-code line', () => {
    expect(residualAfterExitLine('boom')).toBe('boom');
  });

  it('handles junk input', () => {
    expect(residualAfterExitLine('')).toBe('');
    expect(residualAfterExitLine(null)).toBe('');
  });
});

describe('parseGrepInvocation', () => {
  it.each([
    ['bare grep', 'grep resolveModel src/', 'grep', 'resolveModel'],
    ['bundled short flags', 'grep -rn resolveModel src/', 'grep', 'resolveModel'],
    ['ripgrep', 'rg atomicWriteSync', 'rg', 'atomicWriteSync'],
    ['quoted pattern', 'grep -rn "resolveModel" src/', 'grep', 'resolveModel'],
    ['single-quoted pattern', "grep -rn 'zero_result_guard' .", 'grep', 'zero_result_guard'],
    ['-e pattern form', 'grep -e resolveModel src/', 'grep', 'resolveModel'],
    ['context flag consuming its value', 'grep -A 3 resolveModel src/', 'grep', 'resolveModel'],
    ['inline --flag=value', 'grep -rn --include=*.js resolveModel src/', 'grep', 'resolveModel'],
    ['rg type filter', 'rg -t js buildWorkflowPlan lib/', 'rg', 'buildWorkflowPlan'],
    ['end-of-flags marker', 'grep -rn -- resolveModel src/', 'grep', 'resolveModel'],
    ['leading whitespace', '   grep resolveModel src/', 'grep', 'resolveModel'],
  ])('parses %s', (_label, command, tool, pattern) => {
    expect(parseGrepInvocation(command)).toEqual({ tool, pattern });
  });

  it.each([
    ['a non-grep command', 'git diff --stat'],
    ['grep not in leading position', 'ls -la | grep resolveModel'],
    ['a pipeline (exit code belongs to the last stage)', 'grep resolveModel src/ | head -5'],
    ['a chained command', 'cd plugins/artibot && grep resolveModel src/'],
    ['a semicolon list', 'echo hi; grep resolveModel src/'],
    ['git grep (different exit semantics)', 'git grep resolveModel'],
    ['grep as a substring of another binary', 'grepfoo resolveModel'],
    ['a flag-only invocation', 'grep --help'],
  ])('returns no tool for %s', (_label, command) => {
    expect(parseGrepInvocation(command).tool).toBe('');
  });

  it('handles junk input', () => {
    expect(parseGrepInvocation(null)).toEqual({ tool: '', pattern: '' });
    expect(parseGrepInvocation('')).toEqual({ tool: '', pattern: '' });
  });
});

describe('matchZeroResultScope', () => {
  const ctx = (over = {}) => ({
    errorText: 'Exit code 1',
    command: 'grep -rn resolveModel src/',
    exitCode: 1,
    ...over,
  });

  it('fires on a clean grep no-match for an identifier', () => {
    expect(matchZeroResultScope(ctx())).toEqual({ tool: 'grep', pattern: 'resolveModel' });
  });

  it('fires for rg the same way', () => {
    expect(matchZeroResultScope(ctx({ command: 'rg atomicWriteSync lib/' })))
      .toEqual({ tool: 'rg', pattern: 'atomicWriteSync' });
  });

  it('stays silent on exit 2 — that is a grep error, not a clean no-match', () => {
    expect(matchZeroResultScope(ctx({ exitCode: 2 }))).toBeNull();
  });

  it('stays silent when the command printed output (so exit 1 meant something else)', () => {
    expect(matchZeroResultScope(ctx({ errorText: CORPUS.gitDiffExit1 }))).toBeNull();
    expect(matchZeroResultScope(ctx({
      errorText: 'Exit code 1\ngrep: src/: Is a directory',
    }))).toBeNull();
  });

  it('stays silent for a regex query — this guard is about scope, not syntax', () => {
    expect(matchZeroResultScope(ctx({ command: 'grep -rn "export function" src/' }))).toBeNull();
    expect(matchZeroResultScope(ctx({ command: 'grep -rn "resolve.*Model" src/' }))).toBeNull();
  });

  it('stays silent for a plain word with no identifier signal', () => {
    expect(matchZeroResultScope(ctx({ command: 'grep -rn resolve src/' }))).toBeNull();
  });

  it('stays silent when exit code is unknown', () => {
    expect(matchZeroResultScope(ctx({ exitCode: null }))).toBeNull();
  });
});

describe('bash-grep-zero-result through buildAdvice / selectAdvice', () => {
  // The real PostToolUseFailure envelope: failure text is a plain string at
  // top-level `error`, exit status appears only inside it (module doc, 8
  // captured payloads 2026-08-10).
  const payload = (over = {}) => ({
    session_id: 'x',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'grep -rn resolveModel src/' },
    error: 'Exit code 1',
    cwd: root,
    ...over,
  });

  it('advises on a zero-result identifier grep', () => {
    const advice = buildAdvice(payload());
    expect(advice).toContain('[artibot:tool-advice]');
    expect(advice).toContain('resolveModel');
  });

  it('tells the model to verify SCOPE and to say 미확인 rather than 없음', () => {
    // Pinned deliberately: the failures behind this rule had correct patterns
    // and wrong search boundaries. If this ever relaxes into regex coaching,
    // the rule has drifted off its purpose.
    const advice = buildAdvice(payload());
    expect(advice.toLowerCase()).toContain('scope');
    expect(advice).toMatch(/미확인/);
  });

  it('names the rule that fired so the counter can attribute it', () => {
    expect(selectAdvice(payload()).id).toBe('bash-grep-zero-result');
    expect(selectAdvice(payload({
      tool_input: { command: 'cd plugins/artibot && npm test' },
      error: CORPUS.cdRelative,
    })).id).toBe('bash-cd-relative');
  });

  it('selectAdvice returns null when no rule matches', () => {
    expect(selectAdvice(payload({ error: CORPUS.gitDiffExit1 }))).toBeNull();
  });

  it('buildAdvice stays a string-or-null API (existing callers unchanged)', () => {
    expect(typeof buildAdvice(payload())).toBe('string');
    expect(buildAdvice(payload({ error: CORPUS.gitDiffExit1 }))).toBeNull();
  });

  it('stays silent on a grep that found something (never reaches this hook anyway)', () => {
    expect(buildAdvice(payload({
      error: 'Exit code 0\nsrc/x.js:1:resolveModel',
    }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Subprocess E2E + shared counter.
//
// HOME/USERPROFILE redirected to a throwaway dir so the counter never lands in
// the developer's real ~/.claude/artibot store — same mechanism as
// tests/dispatcher/posttooluse-dispatcher.test.js:55-58.
// ---------------------------------------------------------------------------
describe('bash-grep-zero-result (subprocess + counter)', () => {
  const HOOK = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'scripts', 'hooks', 'post-tool-failure-advisor.js',
  );
  const COUNTER_FILENAME = 'zero-result-guard-counter.json';

  let sandboxHome;

  beforeAll(() => {
    sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-advisor-home-'));
  });

  afterAll(() => {
    if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  });

  function runHook(payload) {
    const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const res = spawnSync(process.execPath, [HOOK], {
      input,
      encoding: 'utf-8',
      env: { ...process.env, USERPROFILE: sandboxHome, HOME: sandboxHome },
    });
    return { stdout: res.stdout ?? '', status: res.status };
  }

  function readCounter() {
    const p = path.join(sandboxHome, '.claude', 'artibot', COUNTER_FILENAME);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
  }

  it('emits the scope advice for a live-shaped zero-result grep failure', () => {
    const { stdout, status } = runHook({
      session_id: 'x',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn zero_result_guard src/' },
      error: 'Exit code 1',
      cwd: root,
      duration_ms: 91,
    });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
    expect(out.hookSpecificOutput.additionalContext).toContain('zero_result_guard');
    expect(out.decision).toBeUndefined();
  });

  it('increments the shared counter under byChannel.b2 only', () => {
    const c = readCounter();
    expect(c).not.toBeNull();
    expect(c.byChannel.b2).toBeGreaterThanOrEqual(1);
    expect(c.byChannel.b1).toBe(0);
    expect(c.fired).toBe(c.byChannel.b2);
    expect(Number.isNaN(Date.parse(c.lastFiredAt))).toBe(false);
  });

  it('does not touch the counter for the cd rule (attribution is per-rule)', () => {
    const before = readCounter();
    runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cd plugins/artibot && npm test' },
      error: CORPUS.cdRelative,
      cwd: root,
    });
    const after = readCounter();
    expect(after.fired).toBe(before.fired);
    expect(after.byChannel.b2).toBe(before.byChannel.b2);
  });
});
