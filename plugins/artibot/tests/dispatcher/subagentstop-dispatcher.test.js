import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * SubagentStop dispatcher integration tests.
 *
 * The 3 wrapped SubagentStop hooks (subagent-handler stop /
 * agent-evaluator / workflow-status teammate-update) each implement their
 * own loop guards and graceful no-op paths. The dispatcher's responsibility
 * is only to spawn them, never block the SubagentStop slot, and forward
 * additionalContext / decision=block.
 *
 * The agent-evaluator hook appends to `<home>/.claude/artibot/` (measured:
 * this file created `daily-experiences.json` and `artibot-state.json` under a
 * sandbox home), so the home directory is redirected to a throwaway temp dir
 * for the whole file — same mechanism as `sessionend-dispatcher.test.js`.
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
 *  - cwd -> throwaway NON-git dir. None of the 3 SubagentStop hooks is a
 *    git-autopilot hook (measured 2026-09-04T05:03Z: `HOOKS` =
 *    subagent-handler / agent-evaluator / workflow-status), so unlike
 *    SessionStart there is no `checkout -b` to prevent here. What the plan
 *    flagged instead was `subagent-handler.js:87 payloadProjectRoot` ->
 *    `<projectRoot>/.artibot/ledger/spawns.ndjson`. MEASURED: that write does
 *    NOT reach the repository from this suite, and could not, because
 *    `payloadProjectRoot` reads the PAYLOAD `cwd` key (:80-84) and skips when
 *    it is absent rather than falling back to `process.cwd()` — no payload in
 *    this file carries `cwd`. Baseline run 2026-09-04T05:03:18Z (31/31 pass,
 *    3 files) moved no repo artifact: worktree `autopilot.json` absent before
 *    and after, HEAD/branch/reflog/`artibot/*` identical, `git status
 *    --porcelain` 0 lines both sides. The ledger md5 did change in that
 *    window, and the appended rows were the LIVE session's own SubagentStop
 *    events (`sessionId 9d6dc211-…`, `agentType teammate`) — not fixtures.
 *    That near-miss is why the assertion at the bottom pins fixture session
 *    ids rather than a whole-file hash: a hash here would be a flake, since
 *    a real agent can stop mid-run.
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
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_subagentstop-dispatcher.js');

/** Throwaway home and working directory for the spawned dispatcher. */
let sandboxHome;
let sandboxCwd;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-subagentstop-'));
  sandboxCwd = mkdtempSync(path.join(tmpdir(), 'artibot-subagentstop-cwd-'));
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
 * checkout, and reported 34/34 green. The indirection is the detector.
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

describe('_subagentstop-dispatcher (integration)', () => {
  it('exits 0 for empty payload', () => {
    const { status } = runDispatcher({});
    expect(status).toBe(0);
  });

  it('exits 0 with a typical SubagentStop payload', () => {
    const { status } = runDispatcher({
      session_id: 'subagentstop-test-1',
      stop_hook_active: false,
      transcript_path: '/nonexistent/transcript.jsonl',
      subagent_id: 'sub-1',
    });
    expect(status).toBe(0);
  });

  it('exits 0 even when wrapped hooks see a malformed teammate payload', () => {
    // Each wrapped hook must defensively handle missing fields. Even if one
    // throws internally, the dispatcher spawn-isolates the crash and stays 0.
    const { status } = runDispatcher({
      session_id: 'subagentstop-test-2',
      subagent: null,
      teammate: undefined,
    });
    expect(status).toBe(0);
  });

  it('respects ARTIBOT_DISABLE_SUBAGENTSTOP_DISPATCHER=1', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'subagentstop-disable' },
      { ARTIBOT_DISABLE_SUBAGENTSTOP_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('respects ARTIBOT_DISABLE_DISPATCHER=1 (global)', () => {
    const { stdout, status } = runDispatcher(
      { session_id: 'subagentstop-global-disable' },
      { ARTIBOT_DISABLE_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('emits at most one valid JSON document on stdout', () => {
    const { stdout, status } = runDispatcher({
      session_id: 'subagentstop-stdout',
    });
    expect(status).toBe(0);
    if (stdout.length > 0) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  it('registers all 3 wrapped hooks', async () => {
    const mod = await import('../../scripts/hooks/_subagentstop-dispatcher.js');
    expect(mod.HOOKS).toHaveLength(3);
    const names = mod.HOOKS.map((h) => h.name);
    expect(names).toContain('subagent-handler');
    expect(names).toContain('agent-evaluator');
    expect(names).toContain('workflow-status');
  });

  it('forwards CLI sub-commands as args to subagent-handler / workflow-status', async () => {
    // Preserves the pre-consolidation CLI contract:
    //   subagent-handler.js stop
    //   workflow-status.js teammate-update
    const mod = await import('../../scripts/hooks/_subagentstop-dispatcher.js');
    const byName = Object.fromEntries(mod.HOOKS.map((h) => [h.name, h]));
    expect(byName['subagent-handler'].args).toEqual(['stop']);
    expect(byName['workflow-status'].args).toEqual(['teammate-update']);
    // agent-evaluator takes no CLI args
    expect(byName['agent-evaluator'].args).toBeUndefined();
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
   *     This is what makes the isolation independent of DATA (the `enabled`
   *     flag in `autopilot.json`, an allowlist file) — see
   *     `sessionstart-dispatcher.test.js`, where gating on data was the bug.
   *
   *  2. BEHAVIOURAL: no row this suite could have produced exists in the
   *     project-local spawn ledger. Pinned by fixture session id rather than
   *     by file hash on purpose — the live session appends real SubagentStop
   *     rows to this same file (measured 2026-09-04T05:03:27Z, three rows
   *     landed during the 11.6s baseline run), so a hash comparison would be
   *     a flake, not a detector.
   *
   * WHAT THIS DOES NOT COVER: writes a hook reaches by absolute path rather
   * than through HOME or cwd. `CLAUDE_PLUGIN_ROOT` still points at the real
   * plugin, so writes under `plugins/artibot/runtime/` still land in the repo;
   * they are gitignored (`plugins/artibot/.gitignore:10`) and cannot dirty
   * git, which is why they are left alone.
   */
  it('leaves the real repository untouched (non-git cwd, no fixture row in the spawn ledger)', () => {
    // Read through spawnOptions(), never from `sandboxCwd` directly — that is
    // what makes this assertion go red if the spawn cwd is pointed back at
    // the checkout.
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: spawnOptions().cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();

    const { status } = runDispatcher({
      session_id: 'subagentstop-no-side-effects',
      subagent_id: 'sub-no-side-effects',
    });
    expect(status).toBe(0);

    // Resolved the way the hook would resolve it, from the checkout this file
    // lives in — the ledger the plan flagged as the C-2 blast radius.
    const ledger = path.join(PLUGIN_ROOT, '..', '..', '.artibot', 'ledger', 'spawns.ndjson');
    const rows = existsSync(ledger) ? readFileSync(ledger, 'utf-8') : '';
    for (const fixture of ['subagentstop-test-1', 'subagentstop-test-2', 'subagentstop-no-side-effects']) {
      expect(rows).not.toContain(fixture);
    }
  });
});
