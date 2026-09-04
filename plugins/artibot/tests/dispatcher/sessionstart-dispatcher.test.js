import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * SessionStart dispatcher integration tests.
 *
 * The dispatcher is exec'd as a real child process so we exercise the same
 * code path that hooks.json wires up. Individual hooks are themselves spawned
 * as grand-child processes inside the dispatcher, so each test triggers the
 * full process tree. `spawnHook` passes no `cwd`
 * (`scripts/hooks/_dispatcher-utils.js:126`), so every grand-child inherits
 * whatever cwd this file hands the dispatcher — the cwd below is load-bearing,
 * not incidental.
 *
 * TWO redirections, for two different blast radii:
 *
 *  - HOME/USERPROFILE -> throwaway dir, same mechanism as
 *    `sessionend-dispatcher.test.js`. The wrapped hooks touch runtime/ and
 *    `<home>/.claude/artibot` (measured: this file created
 *    `artibot/update-check.json` under a sandbox home).
 *
 *  - cwd -> throwaway NON-git dir. Two of the 9 hooks are git-autopilot hooks,
 *    and both resolve the repository from process cwd alone:
 *    `git-autopilot-setup.js:105` and `git-autopilot-session.js:61` each run
 *    `git rev-parse --show-toplevel` with no `cwd` option. Spawning from
 *    PLUGIN_ROOT therefore aimed them at the REAL repository:
 *
 *      * `git-autopilot-setup.js:191` gates on
 *        `isAutopilotAllowed(root) || isArtibotRepo(root)` and BOTH are true
 *        here. `isArtibotRepo` finds `plugins/artibot/CLAUDE.md`
 *        (`lib/core/hook-utils.js:188`); `isAutopilotAllowed` matches
 *        `Yoodaddy0311/artibot`, which is compiled into
 *        `lib/autopilot/repo-identity.js#DEFAULT_ALLOWLIST` and applies
 *        whenever the allowlist FILE is absent. The home sandbox does not
 *        close this: the fallback list is a source constant, not a disk read.
 *        So setup ran and rewrote the real `.git/autopilot.json` — a file git
 *        shares across every linked worktree. Measured 2026-09-04T04:38Z
 *        before this fix: `lastSetupAt` 02:52:49.946Z -> 04:38:37.842Z, file
 *        sha256 0e421ecb -> eaa86d05.
 *
 *      * `git-autopilot-session.js:247` then relocates HEAD via
 *        `checkout -b artibot/<branch>`, and its earlier steps run
 *        `pull --rebase --autostash` (:105) and `merge --no-ff` (:206). In the
 *        main tree it happened to stay put, because HEAD sat on the base
 *        branch (:255-258) and the existing config carried `enabled:false`
 *        (:79). Neither is a guarantee. `enabled` is a mutable runtime flag
 *        `/autopilot` setup rewrites, and a linked worktree has its own git
 *        dir with NO autopilot.json, so setup creates one from DEFAULT_CONFIG
 *        (`enabled:true`, `git-autopilot-setup.js:45`) and the checkout does
 *        fire. That is the observed 2026-09-04 incident: four
 *        `artibot/worktree-split-*` branches created by test runs.
 *
 *    A non-git cwd removes the repository itself, so `getRepoRoot()` fails and
 *    both hooks return before any git read or write. That is structural.
 *    Gating on `enabled` or on the allowlist instead would be gating on data.
 *
 * NOT byte-equivalent across cwd, and deliberately so — unlike
 * `stop-dispatcher.test.js`, whose output was verified identical. Measured
 * here 2026-09-04T04:39Z, same for all three non-disabled payloads: merged
 * stdout is 934 bytes from cwd=PLUGIN_ROOT against 521 bytes from a non-git
 * cwd. The whole delta is git-derived content only a real repo can produce —
 * the `[artibot:wip] 37 WIP commit(s)` line, and the repo-scoped
 * `[artibot:handoff]` Next-P0 line degrading to a generic fallback. Exit
 * status (0), JSON validity, and the presence of a string
 * `hookSpecificOutput.additionalContext` are identical under both, so every
 * assertion below keeps the meaning it had; none asserts on git-derived text.
 * A future assertion that needs a repo should build a throwaway one rather
 * than point cwd back at this checkout.
 *
 * The dispatcher swallows any error from the hooks; tests assert only on the
 * dispatcher's own contract (exit code 0, valid JSON stdout or empty stdout,
 * env-disable behavior) plus the side-effect-absence check at the end.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_sessionstart-dispatcher.js');

/** Throwaway home and working directory for the spawned dispatcher. */
let sandboxHome;
let sandboxCwd;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-sessionstart-home-'));
  sandboxCwd = mkdtempSync(path.join(tmpdir(), 'artibot-sessionstart-cwd-'));
});

afterAll(() => {
  if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  if (sandboxCwd) rmSync(sandboxCwd, { recursive: true, force: true });
});

function runDispatcher(payload, env = {}) {
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH],
      {
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
        input: JSON.stringify(payload),
        encoding: 'utf-8',
        timeout: 45000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout?.toString('utf-8') || '';
  }
  return { stdout: stdout.trim(), status };
}

/**
 * Read-only snapshot of the real-repository state the two git-autopilot hooks
 * are able to disturb. Every command runs with `cwd: PLUGIN_ROOT` on purpose —
 * the point is to observe the checkout this test file lives in, never the
 * sandbox. Nothing here writes. Failures collapse to empty string / null so
 * the helper still works in a clone with no reflog and no autopilot config,
 * where null before and a file after is exactly the regression to catch.
 *
 * @returns {{autopilotConfig: string|null, head: string, branch: string,
 *            reflog: string, autopilotBranches: string}}
 */
function realRepoSnapshot() {
  const git = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: PLUGIN_ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  };
  // `--git-path` resolves the linked-worktree case that `<root>/.git` does
  // not, and answers relative to cwd (`../../.git/autopilot.json` from here).
  const rel = git(['rev-parse', '--git-path', 'autopilot.json']);
  let autopilotConfig = null;
  if (rel) {
    try {
      autopilotConfig = readFileSync(path.resolve(PLUGIN_ROOT, rel), 'utf-8');
    } catch {
      autopilotConfig = null;
    }
  }
  return {
    autopilotConfig,
    head: git(['rev-parse', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    reflog: git(['reflog', 'show', 'HEAD', '-3']),
    autopilotBranches: git(['branch', '--list', 'artibot/*']),
  };
}

describe('_sessionstart-dispatcher (integration)', () => {
  it('exits 0 even with empty payload (no hook is allowed to crash the slot)', () => {
    const { status } = runDispatcher({});
    expect(status).toBe(0);
  });

  it('emits at most one valid JSON document on stdout', () => {
    const { stdout, status } = runDispatcher({ session_id: 'test-1' });
    expect(status).toBe(0);
    if (stdout.length > 0) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  it('produces additionalContext when at least one child hook contributes (or null when none)', () => {
    const { stdout } = runDispatcher({ session_id: 'test-ctx' });
    if (stdout.length === 0) return; // permissible: every hook was silent
    const parsed = JSON.parse(stdout);
    if (parsed?.hookSpecificOutput) {
      expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
    }
  });

  it('respects ARTIBOT_DISABLE_SESSIONSTART_DISPATCHER=1 (no-op, exit 0, empty stdout)', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'test-disable' },
      { ARTIBOT_DISABLE_SESSIONSTART_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('respects ARTIBOT_DISABLE_DISPATCHER=1 (global rollback, no-op)', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'test-global-disable' },
      { ARTIBOT_DISABLE_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('registers all 9 wrapped hooks in HOOKS table', async () => {
    const mod = await import('../../scripts/hooks/_sessionstart-dispatcher.js');
    expect(mod.HOOKS).toHaveLength(9);
    const names = mod.HOOKS.map((h) => h.name);
    expect(names).toContain('session-start');
    expect(names).toContain('memory-tracker');
    expect(names).toContain('swarm-download');
    expect(names).toContain('git-autopilot-setup');
    expect(names).toContain('image-cleanup');
    expect(names).toContain('session-digest');
    expect(names).toContain('git-autopilot-session');
    expect(names).toContain('skill-validation-check');
    expect(names).toContain('session-readback');
  });

  it('passes "SessionStart" arg to memory-tracker so it routes to the right handler', async () => {
    const mod = await import('../../scripts/hooks/_sessionstart-dispatcher.js');
    const memoryTracker = mod.HOOKS.find((h) => h.name === 'memory-tracker');
    expect(memoryTracker).toBeTruthy();
    expect(memoryTracker.args).toEqual(['SessionStart']);
  });

  /**
   * Isolation self-check — asserted, not assumed.
   *
   * Before the cwd redirection above, this same spawn rewrote the real
   * `.git/autopilot.json` on every run, and in a linked worktree it also
   * created an `artibot/<branch>` branch. This test reads the real repository
   * and never writes to it.
   *
   * Blind spots it does NOT cover: anything a hook reaches through an absolute
   * path rather than HOME or cwd. `CLAUDE_PLUGIN_ROOT` still points at the real
   * plugin, so writes under `plugins/artibot/runtime/` still land in the repo;
   * they are gitignored (`plugins/artibot/.gitignore:10`) so they cannot dirty
   * git, which is why they are left alone.
   *
   * Two of the five fields are repo-wide rather than test-local, so a
   * concurrent operator action inside the short window would fail this test:
   * `autopilotBranches` (anyone creating an `artibot/*` branch) and
   * `reflog`/`head` (anyone landing on the checked-out branch). Measured
   * 2026-09-04T04:43:46Z, that is not hypothetical — a `pull --ff-only`
   * from an unrelated landing flow moved HEAD seconds after this file's run
   * finished. Both fields are kept anyway: they are the only direct detectors
   * of `checkout -b` (:247) and `pull --rebase` (:105), the two writes this
   * isolation exists to prevent. A failure here means read the reflog before
   * assuming the dispatcher did it.
   */
  it('leaves the real repository untouched (no autopilot.json write, no HEAD move)', () => {
    // Structural proof the git path is shut: the hooks derive the repo from
    // cwd, and there is no repo to find here. This is what makes the isolation
    // independent of `autopilot.json` `enabled`, a flag setup rewrites.
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: sandboxCwd, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();

    const before = realRepoSnapshot();
    const { status } = runDispatcher({ session_id: 'no-side-effects' });
    expect(status).toBe(0);
    const after = realRepoSnapshot();

    // Asserted field by field so a failure names the artifact that moved.
    expect(after.autopilotConfig).toBe(before.autopilotConfig);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(before.branch);
    expect(after.reflog).toBe(before.reflog);
    expect(after.autopilotBranches).toBe(before.autopilotBranches);
  });
});
