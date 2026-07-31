import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_sessionend-dispatcher.js');

/** Throwaway home for the spawned dispatcher. */
let sandboxHome;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-sessionend-'));
});

afterAll(() => {
  if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
});

function runDispatcher(payload, env = {}) {
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH],
      {
        cwd: PLUGIN_ROOT,
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
});
