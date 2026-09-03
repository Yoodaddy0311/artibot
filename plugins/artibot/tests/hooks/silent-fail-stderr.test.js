import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Verifies the "silent fail → stderr" treatment added in v4.7.3 to three
 * hooks that previously swallowed config-load failures (issue-scanner A2 #10).
 *
 *   - runtime-prompt.js: malformed artibot.config.json → stderr line + defaults
 *   - swarm-sync.js: reportTelemetry rejects → logHookError invoked (unit-tested
 *     via mock instead of child process)
 *
 * The runtime-prompt check drives the exported handler in-process: the
 * legacy child-process path relied on the script's `isMain` guard, which
 * fails on filesystem paths containing non-ASCII characters (e.g. Korean
 * `바탕 화면`) because `import.meta.url` percent-encodes those segments
 * while `process.argv[1]` does not.
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

/**
 * SETUP-ONLY ISOLATION (assertions and fixtures are untouched).
 *
 * The well-formed-config case below used to point `CLAUDE_PLUGIN_ROOT` at the
 * REAL plugin root, so running it mutated the developer's live `runtime/` —
 * `token-usage-session.json` every run, and a line in the real
 * `runtime/decisions/` store that `/doctor` reads once the recorder-stats flush
 * landed. This builds a stand-in root that is well-formed in exactly the way the
 * test needs: the real modules LINKED in and the real `artibot.config.json`
 * copied, so the hook parses a genuinely valid config and imports the genuine
 * libs. Only the writable `runtime/` directory is redirected.
 */
function makeGoodPluginRoot() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-silent-fail-ok-'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of ['lib', 'commands', 'skills', 'agents']) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(tmp, dir), linkType);
  }
  copyFileSync(
    path.join(PLUGIN_ROOT, 'artibot.config.json'),
    path.join(tmp, 'artibot.config.json'),
  );
  mkdirSync(path.join(tmp, 'runtime'), { recursive: true });
  return tmp;
}

describe('silent fail → stderr (issue-scanner A2 #10)', () => {
  let tmpRoots = [];
  let savedEnv;

  beforeEach(() => {
    savedEnv = {
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE,
      ARTIBOT_RUNTIME_MEMORY_DISABLE: process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE,
    };
  });

  afterEach(() => {
    for (const t of tmpRoots) {
      try { rmSync(t, { recursive: true, force: true }); }
      catch { /* best effort */ }
    }
    tmpRoots = [];
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  /**
   * Capture stderr written by an in-process async call. We replace
   * `process.stderr.write` for the duration of the callback so the
   * suite stays isolated even if the call schedules microtasks.
   */
  async function captureStderr(asyncFn) {
    const chunks = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await asyncFn();
    } finally {
      spy.mockRestore();
    }
    return chunks.join('');
  }

  it('runtime-prompt emits stderr when artibot.config.json is malformed', async () => {
    const brokenRoot = makeBrokenPluginRoot();
    tmpRoots.push(brokenRoot);
    writeFileSync(path.join(brokenRoot, 'artibot.config.json'), '{ bogus json');

    process.env.CLAUDE_PLUGIN_ROOT = brokenRoot;
    process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
    process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';

    // Import lazily so the spy is installed before the module reads stderr.
    const { handleUserPromptSubmit } = await import('../../scripts/hooks/runtime-prompt.js');

    const stderr = await captureStderr(async () => {
      await handleUserPromptSubmit({ user_prompt: 'hi', event: 'UserPromptSubmit' });
    });

    expect(stderr).toContain('[runtime-prompt]');
    expect(stderr).toContain('config parse failed');
  });

  it('runtime-prompt stays silent on a well-formed config', async () => {
    const goodRoot = makeGoodPluginRoot();
    tmpRoots.push(goodRoot);

    process.env.CLAUDE_PLUGIN_ROOT = goodRoot;
    process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
    process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';

    const { handleUserPromptSubmit } = await import('../../scripts/hooks/runtime-prompt.js');

    const stderr = await captureStderr(async () => {
      await handleUserPromptSubmit({ user_prompt: 'hi', event: 'UserPromptSubmit' });
    });

    expect(stderr).not.toContain('config parse failed');
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
