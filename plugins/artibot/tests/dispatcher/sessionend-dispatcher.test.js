import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * SessionEnd dispatcher integration tests.
 *
 * These spawn the REAL dispatcher, which runs the real SessionEnd pipeline —
 * including the learning stage that appends to `<home>/.claude/artibot/`.
 * The home directory is therefore redirected to a throwaway temp dir for the
 * whole file. Without it the suite writes its fixtures into the developer's
 * own learning store: a measured 244 of 500 rows in `evaluations.json` were
 * `end-test` / `end-stdout` fixtures, i.e. half the corpus that per-model
 * analysis reads. Disabling checkpoint/memory/swarm/network (below) is not
 * enough — the learning writes go through a different path.
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
 *  - cwd -> throwaway NON-git dir. None of the 6 SessionEnd hooks is a
 *    git-autopilot hook (measured 2026-09-04T05:03Z: `HOOKS` = session-end /
 *    swarm-sync / rotation-runner / memory-tracker / http-notify /
 *    session-ledger), so unlike SessionStart there is no `checkout -b` to
 *    prevent here. Three of them do read `process.cwd()`, and all three
 *    reads end in the home sandbox rather than the repo:
 *      * `session-end.js:89` and `memory-tracker.js:134` copy the string into
 *        a state/summary record written under `<home>/.claude/artibot/`.
 *      * `session-ledger.mjs:46` resolves from the PAYLOAD `cwd` key, not
 *        from the process, and skips when it is absent — no payload in this
 *        file carries `cwd`.
 *    MEASURED, baseline run 2026-09-04T05:03:18Z (31/31 pass across the three
 *    dispatcher suites): no repo artifact moved — worktree `autopilot.json`
 *    absent before and after, HEAD/branch/reflog/`artibot/*` identical,
 *    `git status --porcelain` 0 lines both sides.
 *
 *    The redirection is therefore defense in depth plus uniformity, not a
 *    repair of an observed leak: it makes the cwd of every dispatcher suite
 *    structurally incapable of reaching a repository, which is what
 *    `tests/firewall/dispatcher-cwd-sandbox-required.test.js` enforces.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_sessionend-dispatcher.js');

/** Throwaway home and working directory for the spawned dispatcher. */
let sandboxHome;
let sandboxCwd;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-sessionend-'));
  sandboxCwd = mkdtempSync(path.join(tmpdir(), 'artibot-sessionend-cwd-'));
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
      // Disable outbound network from swarm-sync / http-notify in test runs.
      ARTIBOT_SWARM_DISABLE: '1',
      ARTIBOT_HTTP_NOTIFY_DISABLE: '1',
      ...env,
    },
    encoding: 'utf-8',
    timeout: 45000,
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

describe('_sessionend-dispatcher (integration)', () => {
  it('exits 0 with empty payload', () => {
    const { status } = runDispatcher({});
    expect(status).toBe(0);
  });

  it('exits 0 with typical SessionEnd payload', () => {
    const { status } = runDispatcher({
      session_id: 'end-test',
      reason: 'user-quit',
    });
    expect(status).toBe(0);
  });

  it('respects ARTIBOT_DISABLE_SESSIONEND_DISPATCHER=1', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'end-disable' },
      { ARTIBOT_DISABLE_SESSIONEND_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('respects ARTIBOT_DISABLE_DISPATCHER=1 (global)', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'end-global-disable' },
      { ARTIBOT_DISABLE_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('emits at most one valid JSON document', () => {
    const { stdout, status } = runDispatcher({ session_id: 'end-stdout' });
    expect(status).toBe(0);
    if (stdout.length > 0) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  it('registers all 6 wrapped hooks', async () => {
    const mod = await import('../../scripts/hooks/_sessionend-dispatcher.js');
    expect(mod.HOOKS).toHaveLength(6);
    const names = mod.HOOKS.map((h) => h.name);
    expect(names).toContain('session-end');
    expect(names).toContain('swarm-sync');
    expect(names).toContain('rotation-runner');
    expect(names).toContain('memory-tracker');
    expect(names).toContain('http-notify');
    expect(names).toContain('session-ledger');
  });

  it('passes "SessionEnd" arg to memory-tracker', async () => {
    const mod = await import('../../scripts/hooks/_sessionend-dispatcher.js');
    const memoryTracker = mod.HOOKS.find((h) => h.name === 'memory-tracker');
    expect(memoryTracker).toBeTruthy();
    expect(memoryTracker.args).toEqual(['SessionEnd']);
  });

  /**
   * Isolation self-check — asserted, not assumed.
   *
   * Two independent statements, because either one alone can be true while
   * the suite still leaks:
   *
   *  1. STRUCTURAL: the cwd handed to the dispatcher is not inside any git
   *     repository, so every `git rev-parse --show-toplevel` a grand-child
   *     runs from it fails and the hook returns before reading or writing.
   *     This is isolation by TOPOLOGY, not by DATA — see
   *     `sessionstart-dispatcher.test.js`, where gating on a mutable
   *     `enabled` flag was the bug.
   *
   *  2. BEHAVIOURAL: no row this suite could have produced exists in the
   *     project-local session ledger `session-ledger.mjs:46` would target.
   *     Pinned by fixture session id rather than by file hash on purpose —
   *     the live session appends real rows to the same directory, so a hash
   *     comparison would be a flake, not a detector.
   *
   * WHAT THIS DOES NOT COVER: writes a hook reaches by absolute path rather
   * than through HOME or cwd. `CLAUDE_PLUGIN_ROOT` still points at the real
   * plugin, so writes under `plugins/artibot/runtime/` still land in the repo;
   * they are gitignored (`plugins/artibot/.gitignore:10`) and cannot dirty
   * git, which is why they are left alone.
   */
  it('leaves the real repository untouched (non-git cwd, no fixture row in the project ledger)', () => {
    // Read through spawnOptions(), never from `sandboxCwd` directly — that is
    // what makes this assertion go red if the spawn cwd is pointed back at
    // the checkout.
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: spawnOptions().cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();

    const { status } = runDispatcher({
      session_id: 'end-no-side-effects',
      reason: 'user-quit',
    });
    expect(status).toBe(0);

    const ledgerDir = path.join(PLUGIN_ROOT, '..', '..', '.artibot', 'ledger');
    const rows = existsSync(ledgerDir)
      ? readdirSync(ledgerDir)
        .filter((f) => f.endsWith('.ndjson') || f.endsWith('.jsonl'))
        .map((f) => readFileSync(path.join(ledgerDir, f), 'utf-8'))
        .join('')
      : '';
    for (const fixture of ['end-test', 'end-stdout', 'end-no-side-effects']) {
      expect(rows).not.toContain(fixture);
    }
  });
});
