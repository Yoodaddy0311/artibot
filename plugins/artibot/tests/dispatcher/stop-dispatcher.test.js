import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Stop dispatcher integration tests.
 *
 * The 6 wrapped Stop hooks each implement their own stop_hook_active loop
 * guard. The dispatcher's responsibility is only to spawn them, never block
 * the Stop slot, and forward additionalContext / decision=block.
 *
 * TWO redirections, for two different blast radii:
 *
 *  - HOME/USERPROFILE -> throwaway dir, the same mechanism as
 *    `sessionend-dispatcher.test.js`. This file was measured NOT to write the
 *    learning store today, but the slot fans out to 6 hooks and the dispatch
 *    table is designed for appending more (`hooks/dispatch-table.json`), so the
 *    sandbox is what keeps a future hook from silently reaching the real store.
 *
 *  - cwd -> throwaway NON-git dir. `git-autopilot-close` is one of the 6, and
 *    its only kill switches are cwd-derived: `getRepoRoot()` (null outside a
 *    repo) and an allowlist keyed on the git remote. There is no env disable.
 *    Running from a non-repo cwd makes `getRepoRoot()` return null so the hook
 *    returns at git-autopilot-close.js:503, before any git write. Relying on
 *    `.git/autopilot.json` `enabled:false` instead would be relying on a
 *    mutable runtime flag that `/autopilot` setup rewrites.
 *
 *    This is about the SPAWN vector and is still the only lever for it: the
 *    dispatcher launches real child processes, which no import-time guard can
 *    reach. The separate IMPORT vector — a test importing the hook module and
 *    running its top-level body — is now closed by the direct-run guard in
 *    git-autopilot-close.js. Do not read that guard as making this cwd
 *    redirection redundant; they cover different entry points.
 *
 * Verified equivalent, not assumed: every payload below was diffed between
 * cwd=PLUGIN_ROOT and cwd=<non-repo> and the dispatcher output was identical.
 * (`ckpt=<id>` in `message` differs, but it differs run-to-run under a fixed
 * cwd too — it is nondeterministic, not cwd-dependent.)
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_stop-dispatcher.js');

/** Throwaway home and working directory for the spawned dispatcher. */
let sandboxHome;
let sandboxCwd;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-stop-home-'));
  sandboxCwd = mkdtempSync(path.join(tmpdir(), 'artibot-stop-cwd-'));
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

describe('_stop-dispatcher (integration)', () => {
  it('exits 0 for empty payload', () => {
    const { status } = runDispatcher({});
    expect(status).toBe(0);
  });

  it('exits 0 when stop_hook_active=true (loop guard scenario)', () => {
    // All wrapped hooks must short-circuit on stop_hook_active, but even if
    // one didn't, the dispatcher must still exit 0.
    const { status } = runDispatcher({ stop_hook_active: true, session_id: 'stop-test-1' });
    expect(status).toBe(0);
  });

  it('exits 0 with a typical Stop payload', () => {
    const { status } = runDispatcher({
      session_id: 'stop-test-2',
      stop_hook_active: false,
      transcript_path: '/nonexistent/transcript.jsonl',
    });
    expect(status).toBe(0);
  });

  it('respects ARTIBOT_DISABLE_STOP_DISPATCHER=1', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'stop-disable' },
      { ARTIBOT_DISABLE_STOP_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('respects ARTIBOT_DISABLE_DISPATCHER=1 (global)', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'stop-global-disable' },
      { ARTIBOT_DISABLE_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('emits at most one valid JSON document on stdout', () => {
    const { stdout, status } = runDispatcher({
      session_id: 'stop-stdout',
      stop_hook_active: true, // skip heavy work
    });
    expect(status).toBe(0);
    if (stdout.length > 0) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  it('registers all 6 wrapped hooks', async () => {
    const mod = await import('../../scripts/hooks/_stop-dispatcher.js');
    expect(mod.HOOKS).toHaveLength(6);
    const names = mod.HOOKS.map((h) => h.name);
    expect(names).toContain('stop-review-gate');
    expect(names).toContain('dev-verify-gate');
    expect(names).toContain('git-autopilot-close');
    expect(names).toContain('stop-recap');
    expect(names).toContain('session-notes');
    expect(names).toContain('session-ledger');
    // blindspot-check + teach-back were removed from the Stop slot when they
    // became on-demand slash commands (commands/blindspot.md, teach-back.md).
    expect(names).not.toContain('blindspot-check');
    expect(names).not.toContain('teach-back');
  });

  /**
   * Isolation self-check.
   *
   * Blind spots it does NOT cover: anything the hooks reach through an absolute
   * path rather than HOME or cwd — `CLAUDE_PLUGIN_ROOT` still points at the real
   * plugin, so writes under `plugins/artibot/runtime/` still land in the repo
   * (they are gitignored via `plugins/artibot/.gitignore:10`, so they cannot
   * dirty git, which is why they are left alone).
   */
  it('keeps every side effect inside the sandbox', () => {
    // Structural proof the git path is shut: the hooks derive the repo from
    // cwd, and there is no repo to find here. This is what makes the isolation
    // independent of `.git/autopilot.json` `enabled`, a flag setup rewrites.
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: sandboxCwd, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();

    // Canary: the suite currently writes no learning store at all. If a hook is
    // later added to this slot that does, it lands here — failing loudly in a
    // temp dir instead of silently appending to the developer's real store.
    expect(existsSync(path.join(sandboxHome, '.claude'))).toBe(false);
  });
});
