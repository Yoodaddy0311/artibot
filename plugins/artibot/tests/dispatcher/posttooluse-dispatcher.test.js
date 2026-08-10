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
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_posttooluse-dispatcher.js');

/** Throwaway home for the spawned dispatcher. */
let sandboxHome;

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-posttooluse-'));
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
          ...env,
        },
        input: JSON.stringify(payload),
        encoding: 'utf-8',
        timeout: 35000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
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

  it('registers all 10 wrapped hooks', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    expect(mod.HOOKS).toHaveLength(10);
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
});
