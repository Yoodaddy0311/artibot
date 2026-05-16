import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * SubagentStop dispatcher integration tests.
 *
 * The 3 wrapped SubagentStop hooks (subagent-handler stop /
 * agent-evaluator / workflow-status teammate-update) each implement their
 * own loop guards and graceful no-op paths. The dispatcher's responsibility
 * is only to spawn them, never block the SubagentStop slot, and forward
 * additionalContext / decision=block.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_subagentstop-dispatcher.js');

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
});
