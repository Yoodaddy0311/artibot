import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Stop dispatcher integration tests.
 *
 * The 5 wrapped Stop hooks each implement their own stop_hook_active loop
 * guard. The dispatcher's responsibility is only to spawn them, never block
 * the Stop slot, and forward additionalContext / decision=block.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_stop-dispatcher.js');

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
  });
});
