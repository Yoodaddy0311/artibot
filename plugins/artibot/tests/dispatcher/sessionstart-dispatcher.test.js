import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * SessionStart dispatcher integration tests.
 *
 * The dispatcher is exec'd as a real child process so we exercise the same
 * code path that hooks.json wires up. Individual hooks are themselves spawned
 * as grand-child processes inside the dispatcher, so each test triggers the
 * full process tree.
 *
 * Side-effects: the wrapped hooks may touch runtime/ and ~/.claude/artibot.
 * The dispatcher swallows any error from them; tests assert only on the
 * dispatcher's own contract (exit code 0, valid JSON stdout or empty stdout,
 * env-disable behavior).
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_sessionstart-dispatcher.js');

function runDispatcher(payload, env = {}) {
  let stdout = '';
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
    expect(names).toContain('auto-learning-check');
    expect(names).toContain('skill-validation-check');
  });

  it('passes "SessionStart" arg to memory-tracker so it routes to the right handler', async () => {
    const mod = await import('../../scripts/hooks/_sessionstart-dispatcher.js');
    const memoryTracker = mod.HOOKS.find((h) => h.name === 'memory-tracker');
    expect(memoryTracker).toBeTruthy();
    expect(memoryTracker.args).toEqual(['SessionStart']);
  });
});
