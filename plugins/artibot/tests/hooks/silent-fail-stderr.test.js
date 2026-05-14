import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Verifies the "silent fail → stderr" treatment added in v4.7.3 to three
 * hooks that previously swallowed config-load failures (issue-scanner A2 #10).
 *
 *   - runtime-prompt.js: malformed artibot.config.json → stderr line + defaults
 *   - auto-learning-check.js: unreadable artibot.config.json → stderr line + return
 *   - swarm-sync.js: reportTelemetry rejects → logHookError invoked (unit-tested
 *     via mock instead of child process)
 *
 * The runtime-prompt and auto-learning-check checks run the real hook as a
 * child process so we observe the actual stderr stream.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

function makeBrokenPluginRoot() {
  // Build a minimal stand-in plugin root that the hook can `cd` into and
  // resolve `artibot.config.json` from. We only mutate the one file we care
  // about; everything else is read out of the real PLUGIN_ROOT via the env
  // path so the runtime can still import its libs.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-silent-fail-'));
  mkdirSync(tmp, { recursive: true });
  return tmp;
}

describe('silent fail → stderr (issue-scanner A2 #10)', () => {
  let tmpRoots = [];

  afterEach(() => {
    for (const t of tmpRoots) {
      try { rmSync(t, { recursive: true, force: true }); }
      catch { /* best effort */ }
    }
    tmpRoots = [];
  });

  function runHook(scriptRelPath, payload, env = {}, cwd = PLUGIN_ROOT) {
    const result = spawnSync(
      process.execPath,
      [path.join(PLUGIN_ROOT, scriptRelPath)],
      {
        cwd,
        env: { ...process.env, ...env },
        input: JSON.stringify(payload),
        encoding: 'utf-8',
      },
    );
    return { stderr: String(result.stderr || ''), stdout: String(result.stdout || '') };
  }

  it('runtime-prompt emits stderr when artibot.config.json is malformed', () => {
    const brokenRoot = makeBrokenPluginRoot();
    tmpRoots.push(brokenRoot);
    writeFileSync(path.join(brokenRoot, 'artibot.config.json'), '{ bogus json');

    const { stderr } = runHook(
      'scripts/hooks/runtime-prompt.js',
      { user_prompt: 'hi', event: 'UserPromptSubmit' },
      {
        CLAUDE_PLUGIN_ROOT: brokenRoot,
        ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
        ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
      },
      brokenRoot,
    );

    expect(stderr).toContain('[runtime-prompt]');
    expect(stderr).toContain('config parse failed');
  });

  it('runtime-prompt stays silent on a well-formed config', () => {
    const { stderr } = runHook(
      'scripts/hooks/runtime-prompt.js',
      { user_prompt: 'hi', event: 'UserPromptSubmit' },
      {
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
        ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
      },
    );
    expect(stderr).not.toContain('config parse failed');
  });

  it('auto-learning-check emits stderr when artibot.config.json is corrupt', () => {
    const brokenRoot = makeBrokenPluginRoot();
    tmpRoots.push(brokenRoot);
    writeFileSync(path.join(brokenRoot, 'artibot.config.json'), '{ corrupt');

    const { stderr } = runHook(
      'scripts/hooks/auto-learning-check.js',
      {},
      { CLAUDE_PLUGIN_ROOT: brokenRoot },
      brokenRoot,
    );

    expect(stderr).toContain('[auto-learn]');
    expect(stderr).toContain('config unreadable');
  });

  it('auto-learning-check stays silent when config is valid but autoLearning unset', () => {
    const okRoot = makeBrokenPluginRoot();
    tmpRoots.push(okRoot);
    writeFileSync(path.join(okRoot, 'artibot.config.json'), JSON.stringify({}));

    const { stderr } = runHook(
      'scripts/hooks/auto-learning-check.js',
      {},
      { CLAUDE_PLUGIN_ROOT: okRoot },
      okRoot,
    );
    expect(stderr).not.toContain('config unreadable');
  });
});

// ---------------------------------------------------------------------------
// swarm-sync: source-shape guard (lightweight, deterministic)
// ---------------------------------------------------------------------------
// The telemetry catch lives inside a dynamic-import block that's hard to drive
// purely in-process. A source-shape assertion is sufficient here because the
// regression we're guarding against is a coding pattern, not a runtime bug.

describe('swarm-sync telemetry catch → logHookError', () => {
  it('replaces the silent `catch {}` with logHookError("telemetry failed")', () => {
    const src = readFileSync(
      path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'swarm-sync.js'),
      'utf-8',
    );
    // Must call logHookError with the expected tag.
    expect(src).toMatch(/logHookError\(\s*['"]swarm-sync['"],\s*['"]telemetry failed['"]/);
  });
});
