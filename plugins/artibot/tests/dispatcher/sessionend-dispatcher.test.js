import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * SessionEnd dispatcher integration tests.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_sessionend-dispatcher.js');

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
