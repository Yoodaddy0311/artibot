import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * PostToolUse dispatcher integration tests.
 *
 * Verifies:
 *   - Per-tool routing: only hooks declaring the active tool are spawned.
 *   - Exit 0 in every failure path.
 *   - Env-disable behavior (slot + global).
 *   - JSON merge correctness.
 *
 * These spawn the REAL dispatcher, whose universal `tool-tracker` hook appends
 * every payload to `<home>/.claude/artibot/`. The home directory is therefore
 * redirected to a throwaway temp dir for the whole file — same reasoning and
 * same mechanism as `sessionend-dispatcher.test.js`. Without it the fixtures
 * land in the developer's own learning store: `category:'NonexistentToolXYZ'`
 * rows (a tool that does not exist) were measured there. Disabling
 * checkpoint/memory below is not enough — the tracker writes elsewhere.
 *
 * TWO redirections, for two different blast radii — the second one matches
 * `sessionstart-dispatcher.test.js`, which had to add it after a measured
 * incident. `spawnHook` passes no `cwd`
 * (`scripts/hooks/_dispatcher-utils.js:126`), so every grand-child inherits
 * whatever cwd this file hands the dispatcher: the cwd below is load-bearing,
 * not incidental.
 *
 *  - HOME/USERPROFILE -> throwaway dir (above).
 *
 *  - cwd -> throwaway NON-git dir. None of the 11 PostToolUse hooks is a
 *    git-autopilot hook (measured 2026-09-04T05:03Z against `HOOKS`), so
 *    unlike SessionStart there is no `checkout -b` to prevent here. Three
 *    hooks do reach the repository through `process.cwd()`, and all three
 *    reads are read-only:
 *      * `pre-write-guard.js:73-79` resolves the repo root from cwd and tests
 *        it for the Artibot marker, purely to decide whether to advise.
 *      * `post-write-tdd.js:102` gates on `isArtibotRepo(getRepoRoot())`.
 *      * `tool-tracker.js:239` takes `basename(resolveProjectRoot(...))` as a
 *        label; with no payload `cwd`, `resolveProjectRoot` falls back to
 *        `process.cwd()` (`lib/git/project-root.js:122-124`) and the label
 *        becomes the sandbox directory name. The row itself is written under
 *        the sandbox HOME either way.
 *    MEASURED, baseline run 2026-09-04T05:03:18Z (31/31 pass across the three
 *    dispatcher suites): no repo artifact moved — worktree `autopilot.json`
 *    absent before and after, HEAD/branch/reflog/`artibot/*` identical,
 *    `git status --porcelain` 0 lines both sides.
 *
 *    The redirection is therefore defense in depth plus uniformity, not a
 *    repair of an observed leak: it makes the cwd of every dispatcher suite
 *    structurally incapable of reaching a repository, which is what
 *    `tests/firewall/dispatcher-cwd-sandbox-required.test.js` enforces.
 *
 *    NOT output-neutral in one direction, and the assertions below survive it:
 *    `pre-write-guard` now takes its "not an Artibot repo" early return and
 *    stops advising. Nothing here asserts on its advice — the one positive
 *    stdout assertion is `zero-result-guard`, which is cwd-independent.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_posttooluse-dispatcher.js');

/** Throwaway home and working directory for the spawned dispatcher. */
let sandboxHome;
let sandboxCwd;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-posttooluse-'));
  sandboxCwd = mkdtempSync(path.join(tmpdir(), 'artibot-posttooluse-cwd-'));
});

afterAll(() => {
  if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  if (sandboxCwd) rmSync(sandboxCwd, { recursive: true, force: true });
});

/**
 * Spawn options for the dispatcher, in ONE place so the isolation self-check
 * at the bottom reads the same `cwd` the real spawns use. Inlining `cwd:` at
 * the call site instead lets the two drift, and the self-check then passes
 * vacuously: measured 2026-09-04T05:13Z, the first draft of this file kept
 * asserting on the sandbox while the spawn had been pointed back at the
 * checkout, and reported green. The indirection is the detector.
 *
 * @param {Record<string,string>} [env] extra environment for this spawn
 * @returns {import('node:child_process').ExecFileSyncOptions}
 */
function spawnOptions(env = {}) {
  return {
    cwd: sandboxCwd,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      // getHomeDir() reads USERPROFILE then HOME — both must point at the
      // sandbox or the real learning store gets the fixtures.
      USERPROFILE: sandboxHome,
      HOME: sandboxHome,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
      ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
      ...env,
    },
    encoding: 'utf-8',
    timeout: 35000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

function runDispatcher(payload, env = {}) {
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH],
      { ...spawnOptions(env), input: JSON.stringify(payload) },
    );
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout?.toString('utf-8') || '';
  }
  return { stdout: stdout.trim(), status };
}

describe('_posttooluse-dispatcher (integration)', () => {
  it('exits 0 for empty payload', () => {
    const { status } = runDispatcher({});
    expect(status).toBe(0);
  });

  it('exits 0 for unknown tool', () => {
    const { status } = runDispatcher({ tool: 'NonexistentToolXYZ' });
    expect(status).toBe(0);
  });

  it('exits 0 for Bash payload (post-bash + post-bash-failure + tool-tracker)', () => {
    const { status } = runDispatcher({
      tool: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { stdout: 'hi\n' },
    });
    expect(status).toBe(0);
  });

  it('exits 0 for Edit payload (quality-gate + post-edit-format + post-edit-recovery + post-write-tdd + mark-main-agent-edit + tool-tracker)', () => {
    const { status } = runDispatcher({
      tool: 'Edit',
      tool_input: { file_path: '/tmp/nonexistent.txt', old_string: 'a', new_string: 'b' },
    });
    expect(status).toBe(0);
  });

  it('respects ARTIBOT_DISABLE_POSTTOOLUSE_DISPATCHER=1', () => {
    const { stdout, status } = runDispatcher(
      { tool: 'Edit' },
      { ARTIBOT_DISABLE_POSTTOOLUSE_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('respects ARTIBOT_DISABLE_DISPATCHER=1 (global)', () => {
    const { stdout, status } = runDispatcher(
      { tool: 'Edit' },
      { ARTIBOT_DISABLE_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('emits at most one valid JSON document on stdout', () => {
    const { stdout, status } = runDispatcher({ tool: 'Bash', tool_input: { command: 'true' } });
    expect(status).toBe(0);
    if (stdout.length > 0) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  it('registers all 11 wrapped hooks', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    expect(mod.HOOKS).toHaveLength(11);
  });

  it('selectHooks() routes Grep and Glob to zero-result-guard + tool-tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    for (const tool of ['Grep', 'Glob']) {
      const selected = mod.selectHooks(tool).map((h) => h.name);
      expect(selected).toContain('zero-result-guard');
      expect(selected).toContain('tool-tracker');
      expect(selected).not.toContain('quality-gate');
      expect(selected).not.toContain('post-bash');
    }
    // The guard must not reach tools whose responses it cannot interpret.
    expect(mod.selectHooks('Edit').map((h) => h.name)).not.toContain('zero-result-guard');
  });

  // Positive end-to-end assertion: the guard's advice must survive the
  // dispatcher's spawn + mergeResults path, not merely exist in isolation.
  // `No matches found` is the string a live Grep returns for a zero-result
  // content-mode query (measured 2026-08-10).
  it('surfaces zero-result-guard advice through the merged dispatcher output', () => {
    const { stdout, status } = runDispatcher({
      tool: 'Grep',
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveModel', path: 'src/', output_mode: 'content' },
      tool_response: 'No matches found',
    });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('[artibot:zero-result-guard]');
    expect(out.hookSpecificOutput.additionalContext).toContain('resolveModel');
    expect(out.decision).toBeUndefined();
  });

  it('selectHooks() routes Edit tool to quality-gate, post-edit-format, etc. + universal tool-tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('Edit').map((h) => h.name);
    expect(selected).toContain('quality-gate');
    expect(selected).toContain('post-edit-format');
    expect(selected).toContain('post-edit-recovery');
    expect(selected).toContain('post-write-tdd');
    expect(selected).toContain('mark-main-agent-edit');
    expect(selected).toContain('tool-tracker');
    // Edit should NOT fire post-bash or webfetch hooks.
    expect(selected).not.toContain('post-bash');
    expect(selected).not.toContain('webfetch-cache-post');
  });

  it('selectHooks() routes Bash to post-bash + post-bash-failure + tool-tracker only', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('Bash').map((h) => h.name);
    expect(selected).toContain('post-bash');
    expect(selected).toContain('post-bash-failure');
    expect(selected).toContain('tool-tracker');
    expect(selected).not.toContain('quality-gate');
    expect(selected).not.toContain('post-edit-format');
  });

  it('selectHooks() routes Read to pre-write-guard + tool-tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('Read').map((h) => h.name);
    expect(selected).toContain('pre-write-guard');
    expect(selected).toContain('tool-tracker');
    expect(selected).not.toContain('quality-gate');
  });

  it('selectHooks() routes WebFetch to webfetch-cache-post + tool-tracker only', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('WebFetch').map((h) => h.name);
    expect(selected).toContain('webfetch-cache-post');
    expect(selected).toContain('tool-tracker');
    expect(selected).not.toContain('quality-gate');
  });

  it('selectHooks(null) still triggers the universal tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks(null).map((h) => h.name);
    expect(selected).toEqual(['tool-tracker']);
  });

  it('selectHooks() routes MultiEdit to mark-main-agent-edit + tool-tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('MultiEdit').map((h) => h.name);
    expect(selected).toContain('mark-main-agent-edit');
    expect(selected).toContain('tool-tracker');
  });

  /**
   * Isolation self-check — asserted, not assumed.
   *
   * STRUCTURAL, not data-driven: the cwd handed to the dispatcher is not
   * inside any git repository, so every `git rev-parse --show-toplevel` a
   * grand-child runs from it fails and the hook returns before reading or
   * writing. That is what makes the isolation independent of a mutable flag —
   * see `sessionstart-dispatcher.test.js`, where gating on data was the bug.
   *
   * The second half re-reads the working tree afterwards: a hook that writes
   * a formatted file or a recovery artifact into the checkout would show up
   * as a `git status --porcelain` line. `-z` because this repository has
   * Korean paths and `core.quotepath` is on by default — the byte count is
   * compared, not a parsed list, so the assertion needs no path decoding.
   *
   * WHAT THIS DOES NOT COVER: writes a hook reaches by absolute path rather
   * than through HOME or cwd. `CLAUDE_PLUGIN_ROOT` still points at the real
   * plugin, so writes under `plugins/artibot/runtime/` still land in the repo;
   * they are gitignored (`plugins/artibot/.gitignore:10`) and therefore
   * invisible to porcelain, which is why they are left alone. It also cannot
   * see a concurrent operator edit — a failure here means read the diff
   * before assuming the dispatcher did it.
   */
  it('leaves the real repository untouched (non-git cwd, working tree unchanged)', () => {
    // Read through spawnOptions(), never from `sandboxCwd` directly — that is
    // what makes this assertion go red if the spawn cwd is pointed back at
    // the checkout.
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: spawnOptions().cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();

    const porcelain = () => {
      try {
        return execFileSync('git', ['status', '--porcelain', '-z'], {
          cwd: PLUGIN_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        return '';
      }
    };

    const before = porcelain();
    const { status } = runDispatcher({
      tool: 'Edit',
      tool_input: { file_path: '/tmp/nonexistent.txt', old_string: 'a', new_string: 'b' },
    });
    expect(status).toBe(0);
    expect(porcelain()).toBe(before);
  });
});
