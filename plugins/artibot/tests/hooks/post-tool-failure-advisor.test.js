import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Mocks — same shape as tests/hooks/post-bash-failure.test.js
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  writeStdout: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  getPluginRoot: vi.fn(() => '/plugin-root'),
}));

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');

const {
  buildAdvice,
  buildDuplicatedPrefixMessage,
  classifyPermissionDenial,
  extractErrorText,
  extractExitCode,
  extractInputPath,
  isRelativePath,
  matchDuplicatedPathPrefix,
  matchRelativeCd,
  ADVICE_RULE_IDS,
} = await import('../../scripts/hooks/post-tool-failure-advisor.js');

// ---------------------------------------------------------------------------
// Real-corpus fixtures.
//
// Every string below was dumped verbatim from
// ~/.claude/projects/C--Users-HeechangLee-Desktop-Artibot/**/*.jsonl
// (tool_result entries with is_error === true, 38 total, 2026-08-10).
// They are NOT invented — see the WP-C report for the extraction command.
// ---------------------------------------------------------------------------
const CORPUS = {
  cdRelative: 'Exit code 1\n/usr/bin/bash: line 1: cd: plugins/artibot: No such file or directory',
  cdRelativeEmbedded:
    'Exit code 1\n=== 실제 WIP 커밋 (HEAD 기준) ===\n0\n0\n=== 전체 이력 WIP ===\n31\n'
    + '=== test-status 재시도 ===\n/usr/bin/bash: line 1: cd: plugins/artibot: No such file or directory',
  pathNotExistRelative:
    '<tool_use_error>Path does not exist: plugins/artibot/docs/ORCHESTRATION-ROUTING.md. '
    + 'Note: your current working directory is C:\\Users\\HeechangLee\\Desktop\\Artibot\\plugins\\artibot.</tool_use_error>',
  fileNotExistAbsolute:
    'File does not exist. Note: your current working directory is C:\\Users\\HeechangLee\\Desktop\\Artibot.',
  writeBeforeRead:
    '[WRITE-BEFORE-READ] Edit blocked for "C:\\Users\\HeechangLee\\Desktop\\Artibot\\plugins\\artibot\\commands\\ultraplan.md". '
    + 'File exists but was not Read in this session. Read the file first to understand its contents before modifying.',
  notReadYet: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
  userDeclined: "The user doesn't want to proceed with this tool use.",
  timedOut: 'Exit code 143\nCommand timed out after 3m 0s',
  bashSyntax: 'Exit code 2\n/usr/bin/bash: eval: line 1: unexpected EOF while looking for matching `"\'',
  nodeEnoent:
    'Exit code 1\nnode:fs:441\n    return binding.readFileUtf8(path, stringToFlags(options.flag));\n'
    + "\nError: ENOENT: no such file or directory, open 'C:\\tmp\\handoff.md'",
  gitDiffExit1:
    'Exit code 1\n plugins/artibot/package.json                       |  2 +-\n'
    + ' plugins/artibot/rules/agent-coordination.md        | 11 +++---',
};

// ---------------------------------------------------------------------------
// Filesystem fixture: the advisor only speaks when it can VERIFY the corrected
// target exists, so these tests need a real tree rather than a mocked fs.
//
//   <root>/plugins/artibot/docs/ORCHESTRATION-ROUTING.md
//
// This mirrors the shape of the two real duplicated-prefix failures.
// ---------------------------------------------------------------------------
let root;
let nestedCwd;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-advisor-'));
  nestedCwd = path.join(root, 'plugins', 'artibot');
  mkdirSync(path.join(nestedCwd, 'docs'), { recursive: true });
  writeFileSync(path.join(nestedCwd, 'docs', 'ORCHESTRATION-ROUTING.md'), '# doc\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractErrorText — payload shape is defensive because the exact
// PostToolUseFailure envelope is not documented in this repo (see module doc).
// ---------------------------------------------------------------------------
describe('extractErrorText', () => {
  it('reads a bare string tool_response', () => {
    expect(extractErrorText({ tool_response: CORPUS.cdRelative })).toBe(CORPUS.cdRelative);
  });

  it('reads tool_response.content', () => {
    expect(extractErrorText({ tool_response: { content: 'boom' } })).toBe('boom');
  });

  it('reads tool_response.stderr', () => {
    expect(extractErrorText({ tool_response: { stderr: 'bad things' } })).toBe('bad things');
  });

  it('reads the legacy tool_result alias', () => {
    expect(extractErrorText({ tool_result: { output: 'legacy' } })).toBe('legacy');
  });

  it('reads a top-level error string', () => {
    expect(extractErrorText({ error: 'top level' })).toBe('top level');
  });

  it('reads error.message', () => {
    expect(extractErrorText({ error: { message: 'nested' } })).toBe('nested');
  });

  it('flattens an anthropic-style content block array', () => {
    expect(extractErrorText({
      tool_response: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    })).toBe('a\nb');
  });

  it('returns empty string when nothing matches', () => {
    expect(extractErrorText({})).toBe('');
    expect(extractErrorText(null)).toBe('');
  });
});

describe('extractExitCode', () => {
  it('reads tool_response.exit_code', () => {
    expect(extractExitCode({ tool_response: { exit_code: 127 } })).toBe(127);
  });

  it('reads the camelCase variant', () => {
    expect(extractExitCode({ tool_response: { exitCode: 126 } })).toBe(126);
  });

  it('returns null when absent', () => {
    expect(extractExitCode({})).toBeNull();
  });
});

describe('extractInputPath', () => {
  it('reads tool_input.file_path (Read/Edit shape)', () => {
    expect(extractInputPath({ tool_input: { file_path: 'a/b.js' } })).toBe('a/b.js');
  });

  it('reads tool_input.path (Grep/Glob shape)', () => {
    expect(extractInputPath({ tool_input: { path: 'a/b.js' } })).toBe('a/b.js');
  });

  it('returns empty string when absent', () => {
    expect(extractInputPath({ tool_input: {} })).toBe('');
  });
});

describe('isRelativePath', () => {
  it('treats a Windows drive path as absolute', () => {
    expect(isRelativePath('C:\\Users\\x\\y.md')).toBe(false);
    expect(isRelativePath('C:/Users/x/y.md')).toBe(false);
  });

  it('treats a UNC path as absolute', () => {
    expect(isRelativePath('\\\\server\\share\\y.md')).toBe(false);
  });

  it('treats a POSIX root path as absolute', () => {
    expect(isRelativePath('/usr/local/bin')).toBe(false);
  });

  it('treats a ~ path as absolute (home-anchored)', () => {
    expect(isRelativePath('~/x/y')).toBe(false);
  });

  it('treats a bare segment path as relative', () => {
    expect(isRelativePath('plugins/artibot')).toBe(true);
    expect(isRelativePath('./docs/x.md')).toBe(true);
  });

  it('returns false for empty input (nothing to advise on)', () => {
    expect(isRelativePath('')).toBe(false);
    expect(isRelativePath(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyPermissionDenial (PRD §5.4 C-3, R9)
//
// SCOPE HONESTY: this classifier matched 0 of the 38 real failures in the
// corpus. This is a Windows-local repo, so sandbox / seccomp / landlock denials
// never appear here. Non-firing is the CORRECT behaviour in this environment;
// the code exists for cross-platform coverage, not for an observed problem.
// ---------------------------------------------------------------------------
describe('classifyPermissionDenial', () => {
  it('quick-rejects exit 127 even when stderr says "permission denied" (R9)', () => {
    const out = classifyPermissionDenial({ stderr: 'permission denied', exitCode: 127 });
    expect(out.denied).toBe(false);
    expect(out.reason).toBe('quick-reject-exit-code');
  });

  it('quick-rejects exit 126 (not executable), not a permission problem', () => {
    expect(classifyPermissionDenial({ stderr: 'permission denied', exitCode: 126 }).denied).toBe(false);
  });

  it('quick-rejects exit 2 (shell misuse)', () => {
    expect(classifyPermissionDenial({ stderr: 'operation not permitted', exitCode: 2 }).denied).toBe(false);
  });

  it('classifies "operation not permitted" at exit 1 as a denial', () => {
    const out = classifyPermissionDenial({ stderr: 'operation not permitted', exitCode: 1 });
    expect(out.denied).toBe(true);
    expect(out.keyword).toBe('operation not permitted');
  });

  it.each([
    'operation not permitted',
    'permission denied',
    'read-only file system',
    'seccomp',
    'sandbox',
    'landlock',
    'failed to write file',
  ])('recognises keyword %s', (keyword) => {
    expect(classifyPermissionDenial({ stderr: `prefix ${keyword} suffix`, exitCode: 1 }).denied).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(classifyPermissionDenial({ stderr: 'Operation Not Permitted', exitCode: 1 }).denied).toBe(true);
  });

  it('classifies a denial with no exit code at all (MCP-style)', () => {
    expect(classifyPermissionDenial({ stderr: 'landlock blocked', exitCode: null }).denied).toBe(true);
  });

  it('returns not-denied for unrelated stderr', () => {
    expect(classifyPermissionDenial({ stderr: 'ENOENT no such file', exitCode: 1 }).denied).toBe(false);
  });

  it('tolerates missing arguments', () => {
    expect(classifyPermissionDenial().denied).toBe(false);
    expect(classifyPermissionDenial({}).denied).toBe(false);
  });

  it.each(Object.entries(CORPUS))(
    'does not flag real corpus sample %s as a permission denial',
    (_name, text) => {
      expect(classifyPermissionDenial({ stderr: text, exitCode: 1 }).denied).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Rule 1 — relative `cd` failure (3 observations / 2 sessions)
// ---------------------------------------------------------------------------
describe('matchRelativeCd', () => {
  it('matches the real corpus cd failure and captures the target', () => {
    const hit = matchRelativeCd({ errorText: CORPUS.cdRelative, cwd: root });
    expect(hit).not.toBeNull();
    expect(hit.target).toBe('plugins/artibot');
  });

  it('matches when the cd failure is embedded mid-output', () => {
    expect(matchRelativeCd({ errorText: CORPUS.cdRelativeEmbedded, cwd: root }).target)
      .toBe('plugins/artibot');
  });

  it('resolves the verified absolute directory when it exists under cwd', () => {
    const hit = matchRelativeCd({ errorText: CORPUS.cdRelative, cwd: root });
    expect(hit.absolute).toBe(path.resolve(root, 'plugins/artibot'));
  });

  it('leaves absolute null when the directory cannot be verified', () => {
    const hit = matchRelativeCd({
      errorText: 'bash: line 1: cd: nowhere/at/all: No such file or directory',
      cwd: root,
    });
    expect(hit).not.toBeNull();
    expect(hit.absolute).toBeNull();
  });

  it('stays silent when the cd target is already absolute', () => {
    expect(matchRelativeCd({
      errorText: 'bash: line 1: cd: /opt/missing: No such file or directory',
      cwd: root,
    })).toBeNull();
  });

  it('stays silent for unrelated errors', () => {
    expect(matchRelativeCd({ errorText: CORPUS.bashSyntax, cwd: root })).toBeNull();
    expect(matchRelativeCd({ errorText: CORPUS.nodeEnoent, cwd: root })).toBeNull();
    expect(matchRelativeCd({ errorText: '', cwd: root })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — relative path whose leading segments duplicate the cwd tail
// (2 observations / 1 session). Deliberately narrower than "steer to absolute
// paths": 4 of the 6 real path-not-found failures already passed an ABSOLUTE
// path, so blanket absolute-path advice would have helped none of them.
// ---------------------------------------------------------------------------
describe('matchDuplicatedPathPrefix', () => {
  it('detects the duplicated plugins/artibot prefix from the real failure', () => {
    const hit = matchDuplicatedPathPrefix({
      errorText: CORPUS.pathNotExistRelative,
      inputPath: 'plugins/artibot/docs/ORCHESTRATION-ROUTING.md',
      cwd: nestedCwd,
    });
    expect(hit).not.toBeNull();
    expect(hit.corrected).toBe('docs/ORCHESTRATION-ROUTING.md');
    expect(hit.correctedAbsolute).toBe(path.resolve(nestedCwd, 'docs/ORCHESTRATION-ROUTING.md'));
  });

  it('reports the wrong resolution the model actually caused', () => {
    const hit = matchDuplicatedPathPrefix({
      errorText: CORPUS.pathNotExistRelative,
      inputPath: 'plugins/artibot/docs/ORCHESTRATION-ROUTING.md',
      cwd: nestedCwd,
    });
    expect(hit.resolved).toBe(
      path.resolve(nestedCwd, 'plugins/artibot/docs/ORCHESTRATION-ROUTING.md'),
    );
  });

  it('handles backslash-separated input paths', () => {
    const hit = matchDuplicatedPathPrefix({
      errorText: CORPUS.pathNotExistRelative,
      inputPath: 'plugins\\artibot\\docs\\ORCHESTRATION-ROUTING.md',
      cwd: nestedCwd,
    });
    expect(hit).not.toBeNull();
    expect(hit.corrected).toBe('docs/ORCHESTRATION-ROUTING.md');
  });

  it('stays silent when the input path is absolute (4 of 6 real cases)', () => {
    expect(matchDuplicatedPathPrefix({
      errorText: CORPUS.fileNotExistAbsolute,
      inputPath: 'C:\\Users\\HeechangLee\\Desktop\\Artibot\\tests\\ci\\statusline-schema.test.js',
      cwd: 'C:\\Users\\HeechangLee\\Desktop\\Artibot',
    })).toBeNull();
  });

  it('stays silent when there is no duplicated prefix', () => {
    expect(matchDuplicatedPathPrefix({
      errorText: CORPUS.pathNotExistRelative,
      inputPath: 'docs/NOPE.md',
      cwd: nestedCwd,
    })).toBeNull();
  });

  it('stays silent when the de-duplicated target does not exist either', () => {
    expect(matchDuplicatedPathPrefix({
      errorText: CORPUS.pathNotExistRelative,
      inputPath: 'plugins/artibot/docs/DOES-NOT-EXIST.md',
      cwd: nestedCwd,
    })).toBeNull();
  });

  it('stays silent when the error is not a path-not-found error', () => {
    expect(matchDuplicatedPathPrefix({
      errorText: CORPUS.writeBeforeRead,
      inputPath: 'plugins/artibot/docs/ORCHESTRATION-ROUTING.md',
      cwd: nestedCwd,
    })).toBeNull();
  });

  it('stays silent without a cwd', () => {
    expect(matchDuplicatedPathPrefix({
      errorText: CORPUS.pathNotExistRelative,
      inputPath: 'plugins/artibot/docs/ORCHESTRATION-ROUTING.md',
      cwd: '',
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildAdvice — the allowlist dispatcher. Silence is the default.
// ---------------------------------------------------------------------------
describe('buildAdvice allowlist', () => {
  it('exposes exactly the shipped rule ids', () => {
    // duplicated-path-prefix is deliberately NOT here. Measured 2026-08-10 via
    // raw hook-stdin dumps: <tool_use_error> failures (Grep/Read "Path does not
    // exist", Edit "String to replace not found", PreToolUse blocks) emit no
    // PostToolUse and no PostToolUseFailure event, so that rule can never fire.
    // If a future platform version delivers such a payload, re-add it here.
    //
    // bash-grep-zero-result joined in WP-3 B-2: a `grep`/`rg` that exits 1 with
    // no output is a zero-result identifier lookup, which is the Bash-side twin
    // of the Grep/Glob tool guard in scripts/hooks/zero-result-guard.js.
    expect(ADVICE_RULE_IDS).toEqual(['bash-cd-relative', 'bash-grep-zero-result']);
  });

  it('stays silent on a duplicated-prefix path failure (rule not wired — unreachable)', () => {
    expect(buildAdvice({
      tool_name: 'Grep',
      tool_input: { pattern: '/dynamic', path: 'plugins/artibot/docs/ORCHESTRATION-ROUTING.md' },
      error: CORPUS.pathNotExistRelative,
      cwd: nestedCwd,
    })).toBeNull();
  });

  // AC-5a: fail-closed. Pinning ADVICE_RULE_IDS fixes the array's CONTENTS but
  // never exercises the emptied state, so it cannot catch a hardcoded emission
  // added OUTSIDE the rules loop. This compiles a variant of the real source
  // with ADVICE_RULES emptied and runs it: with zero rules, every input —
  // including payloads the shipped build does advise on — must stay silent.
  //
  // Fail-closed by construction: if the substitutions stop matching (the source
  // was reformatted), the assertions below reject the unmodified module rather
  // than passing vacuously, because the real build DOES advise on the cd payload.
  it('AC-5a: emits nothing for any input when the rule array is emptied', async () => {
    const advisorPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'scripts', 'hooks', 'post-tool-failure-advisor.js',
    );
    const src = readFileSync(advisorPath, 'utf-8');

    const emptied = src
      .replace(/const ADVICE_RULES = \[[\s\S]*?\n\];/, 'const ADVICE_RULES = [];')
      // Rewrite relative imports to absolute URLs so the variant can live in a
      // temp dir instead of being written into the source tree.
      .replace("'../utils/index.js'", JSON.stringify(pathToFileURL(
        path.resolve(path.dirname(advisorPath), '..', 'utils', 'index.js')).href))
      .replace("'../../lib/core/hook-utils.js'", JSON.stringify(pathToFileURL(
        path.resolve(path.dirname(advisorPath), '..', '..', 'lib', 'core', 'hook-utils.js')).href))
      .replace("'./zero-result-guard.js'", JSON.stringify(pathToFileURL(
        path.resolve(path.dirname(advisorPath), 'zero-result-guard.js')).href))
      .replace("'./_main-entry.js'", JSON.stringify(pathToFileURL(
        path.resolve(path.dirname(advisorPath), '_main-entry.js')).href))
      // Drop the entry point: the variant is imported for buildAdvice only, and
      // the real main() would block on stdin. The call sits INSIDE the
      // `if (isMainEntry(import.meta.url)) { … }` block, so the whole block
      // goes — an earlier version anchored `^main\(\)\.catch` at line start,
      // never matched the indented call, and was a permanent no-op whose
      // companion assertion passed vacuously (cross-review finding 2).
      .replace(/\nif \(isMainEntry\(import\.meta\.url\)\) \{[\s\S]*?\n\}/, '\n');

    expect(emptied).not.toBe(src);
    expect(emptied).toContain('const ADVICE_RULES = [];');
    // The strip must actually remove something. Asserting only the absence of
    // a pattern lets a non-matching regex look like a successful strip, which
    // is exactly how the previous no-op survived.
    expect(src).toContain('main().catch');
    expect(emptied).not.toContain('main().catch');

    const dir = mkdtempSync(path.join(tmpdir(), 'advisor-empty-'));
    try {
      const variantPath = path.join(dir, 'advisor-no-rules.mjs');
      writeFileSync(variantPath, emptied);
      const variant = await import(pathToFileURL(variantPath).href);

      expect(variant.ADVICE_RULE_IDS).toEqual([]);

      const inputs = [
        // The shipped build advises on this one — proof the harness is live.
        { tool_name: 'Bash', tool_input: { command: 'cd plugins/artibot && npm test' }, error: CORPUS.cdRelative, cwd: root },
        { tool_name: 'Bash', tool_input: {}, tool_response: CORPUS.cdRelativeEmbedded, cwd: root },
        { tool_name: 'Grep', tool_input: { path: 'plugins/artibot/docs/ORCHESTRATION-ROUTING.md' }, error: CORPUS.pathNotExistRelative, cwd: nestedCwd },
        { tool_name: 'Edit', tool_input: { file_path: 'C:\\x\\y.md' }, error: CORPUS.writeBeforeRead, cwd: root },
        { tool_name: 'Bash', tool_input: {}, error: CORPUS.timedOut, cwd: root },
        { tool_name: 'Bash', tool_input: {}, error: 'a brand new failure mode', cwd: root },
        {},
        null,
      ];
      for (const input of inputs) {
        expect(variant.buildAdvice(input)).toBeNull();
      }

      // Control: the SHIPPED build does advise on the first input, so the
      // silence above comes from the emptied array, not from a broken harness.
      expect(buildAdvice(inputs[0])).toContain('[artibot:tool-advice]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('advises on the real cd failure with cause and next call', () => {
    const advice = buildAdvice({
      tool_name: 'Bash',
      tool_input: { command: 'cd plugins/artibot && npm test' },
      tool_response: CORPUS.cdRelative,
      cwd: root,
    });
    expect(advice).toContain('[artibot:tool-advice]');
    expect(advice).toContain('plugins/artibot');
    expect(advice).toContain(path.resolve(root, 'plugins/artibot'));
    expect(advice).toMatch(/working directory/i);
  });

  // The Rule 2 message builder is retained but unwired. Testing it directly
  // keeps it honest without pretending the hook can reach it.
  it('buildDuplicatedPrefixMessage still names the corrected path (retained, unwired)', () => {
    const hit = matchDuplicatedPathPrefix({
      errorText: CORPUS.pathNotExistRelative,
      inputPath: 'plugins/artibot/docs/ORCHESTRATION-ROUTING.md',
      cwd: nestedCwd,
    });
    const msg = buildDuplicatedPrefixMessage(hit, 'Grep');
    expect(msg).toContain('[artibot:tool-advice]');
    expect(msg).toContain(path.resolve(nestedCwd, 'docs/ORCHESTRATION-ROUTING.md'));
  });

  it.each([
    ['WRITE-BEFORE-READ block', CORPUS.writeBeforeRead],
    ['file-not-read-yet', CORPUS.notReadYet],
    ['user declined', CORPUS.userDeclined],
    ['command timeout', CORPUS.timedOut],
    ['bash syntax error', CORPUS.bashSyntax],
    ['node ENOENT', CORPUS.nodeEnoent],
    ['git diff exit 1', CORPUS.gitDiffExit1],
  ])('stays silent on %s', (_label, text) => {
    expect(buildAdvice({ tool_name: 'Bash', tool_input: {}, tool_response: text, cwd: root })).toBeNull();
  });

  it('stays silent on an unrecognised error (allowlist, not denylist)', () => {
    expect(buildAdvice({
      tool_name: 'Bash',
      tool_input: {},
      tool_response: 'Exit code 1\nsome brand new failure mode nobody has seen',
      cwd: root,
    })).toBeNull();
  });

  it('stays silent when the failure is a permission denial', () => {
    expect(buildAdvice({
      tool_name: 'Bash',
      tool_input: { command: 'cd plugins/artibot' },
      tool_response: {
        stderr: 'cd: plugins/artibot: No such file or directory\noperation not permitted',
        exit_code: 1,
      },
      cwd: root,
    })).toBeNull();
  });

  it('stays silent on empty / malformed payloads', () => {
    expect(buildAdvice(null)).toBeNull();
    expect(buildAdvice({})).toBeNull();
    expect(buildAdvice({ tool_name: 'Bash', tool_response: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hook main() integration — real subprocess
//
// These used to drive main() by importing the module, which worked only because
// the module invoked main() at load time. That is exactly the defect that hung
// the suite three times via session-end.js, so the hook now carries a
// direct-run guard. With the guard, an import no longer runs main() — so
// import-driven assertions would silently stop testing anything (two of them
// would have kept "passing" while asserting nothing).
//
// Spawning the real script is therefore both the honest replacement and a
// stronger test: it exercises the actual production path, and it proves the
// guard still PERMITS direct execution rather than disabling the hook.
// ---------------------------------------------------------------------------
describe('post-tool-failure-advisor hook (subprocess)', () => {
  const HOOK = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'scripts', 'hooks', 'post-tool-failure-advisor.js',
  );

  /**
   * @returns {{ stdout: string, status: number }}
   */
  function runHook(payload) {
    const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const res = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf-8' });
    return { stdout: res.stdout ?? '', status: res.status };
  }

  it('emits additionalContext under the PostToolUseFailure event name', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cd plugins/artibot && npm test' },
      error: CORPUS.cdRelative,
      cwd: root,
    });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
    expect(out.hookSpecificOutput.additionalContext).toContain('[artibot:tool-advice]');
  });

  it('reads the real PostToolUseFailure envelope (top-level error, no tool_response)', () => {
    // Shape captured live 2026-08-10 — the failure text is a plain string at
    // top-level `error` and there is no tool_response key at all.
    const { stdout } = runHook({
      session_id: 'x',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'cd plugins/artibot && npm test' },
      error: 'Exit code 1\n/usr/bin/bash: line 1: cd: plugins/artibot: No such file or directory',
      cwd: root,
      duration_ms: 230,
    });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext)
      .toContain(path.resolve(root, 'plugins/artibot'));
  });

  it('never emits a block decision (advisory only)', () => {
    const { stdout } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cd plugins/artibot' },
      error: CORPUS.cdRelative,
      cwd: root,
    });
    const out = JSON.parse(stdout);
    expect(out.decision).toBeUndefined();
    expect(stdout).not.toContain('block');
  });

  it.each([
    ['an unrecognised failure', CORPUS.gitDiffExit1],
    ['the WRITE-BEFORE-READ block', CORPUS.writeBeforeRead],
    ['a user-declined tool use', CORPUS.userDeclined],
  ])('writes nothing for %s', (_label, errorText) => {
    const { stdout, status } = runHook({
      tool_name: 'Bash', tool_input: {}, error: errorText, cwd: root,
    });
    expect(stdout.trim()).toBe('');
    expect(status).toBe(0);
  });

  it('survives malformed stdin without throwing', () => {
    const { stdout, status } = runHook('not json {{{');
    expect(stdout.trim()).toBe('');
    expect(status).toBe(0);
  });

  it('direct-run guard: importing the module does NOT execute main()', async () => {
    // The guard's whole purpose. If this regresses, importing the hook runs the
    // real pipeline and blocks on stdin — the failure mode that timed out the
    // suite three times.
    vi.clearAllMocks();
    readStdin.mockResolvedValue(JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'cd plugins/artibot' },
      error: CORPUS.cdRelative,
      cwd: root,
    }));
    await import('../../scripts/hooks/post-tool-failure-advisor.js');
    await new Promise((r) => setTimeout(r, 30));
    expect(readStdin).not.toHaveBeenCalled();
    expect(writeStdout).not.toHaveBeenCalled();
  });
});
