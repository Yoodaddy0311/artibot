/**
 * FIX-2 — effort write must precede the pipeline read (no stale off-by-one).
 *
 * runtime-prompt.js used to run fallbackPreparePrompt (whose tasks middleware
 * READS runtime/current-effort.json) BEFORE resolveEffortMeta (which WRITES
 * that file). So on prompt N the pipeline saw prompt N-1's effort. The fix
 * reorders the write ahead of the read.
 *
 * This suite seeds a STALE current-effort.json, fires a fresh slash command,
 * and asserts the file + output reflect the CURRENT command — never the stale
 * one. The keystone read-after-write itself is proven in
 * tests/runtime/create-artibot-agent-pluginroot.test.js.
 *
 * ── Why a LINKED sandbox root, not the real one ───────────────────────────────
 * Until 2026-08-30 this suite ran against the REAL plugin root and restored the
 * developer's runtime/*.json in afterEach. Restoring by rewriting the original
 * bytes is not a no-op: `writeFileSync` stamps a fresh mtime even when the
 * content is identical, so every run left files whose mtime said "just now"
 * while their `updatedAt` still said months ago. That contradiction is not
 * cosmetic — it cost a full investigation on 2026-08-29, because
 * `persistEffortMeta` (scripts/hooks/runtime-prompt.js#persistEffortMeta) stamps
 * `new Date()` on every write and therefore CANNOT produce that pairing. The
 * restore also raced: two suites touching the same globals resolved
 * last-writer-wins, so a concurrent run could hand the developer another
 * suite's state.
 *
 * The old header claimed a temp root was impossible here ("lib/cognitive/router
 * .js stops resolving"). That is true only of a BARE temp root. The hook
 * dynamically `import()`s modules under `getPluginRoot()`, so the fix is to LINK
 * them in rather than to give up isolation — exactly what the sibling suite
 * tests/hooks/runtime-prompt-effort-inject.test.js#LINKED_DIRS already does.
 * Links, not copies, so the REAL modules run: a sandbox missing them would send
 * every dynamic import into its catch block and the assertions below would pass
 * for the wrong reason.
 *
 * Consequence: this file no longer writes ANY path under the repo. There is
 * nothing to restore, so there is no restore race and no mtime side effect.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');

/**
 * Read-only directories the hook resolves through `getPluginRoot()` at runtime.
 * Junctioned on Windows, plain dir symlinks elsewhere; `fs.rmSync` unlinks the
 * link itself rather than recursing through it (verified 2026-08-30 against a
 * throwaway target), so tearing the sandbox down cannot reach the repo.
 */
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];

let sandboxRoot = '';
let effortFile = '';
let savedEnv;

beforeAll(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'artibot-effort-order-'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of LINKED_DIRS) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(sandboxRoot, dir), linkType);
  }
  copyFileSync(REAL_CONFIG_PATH, path.join(sandboxRoot, 'artibot.config.json'));
  mkdirSync(path.join(sandboxRoot, 'runtime'), { recursive: true });
  // The decision store is anchored on the PROJECT root, not CLAUDE_PLUGIN_ROOT
  // (`decision-events.js#getDecisionStoreDir`, changed 2026-09-03), so
  // redirecting the plugin root no longer keeps this suite out of the real
  // store. A `.git` marker makes `lib/git/project-root.js#resolveProjectRoot`
  // stop here, and every payload below carries `cwd` pointing at this root.
  mkdirSync(path.join(sandboxRoot, '.git'), { recursive: true });
  effortFile = path.join(sandboxRoot, 'runtime', 'current-effort.json');
});

afterAll(() => {
  if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Seed a STALE effort file as if left over from a prior prompt.
  writeFileSync(
    effortFile,
    JSON.stringify({ command: 'daily', effort: 'low', baseline: 'low', shift: 0, reason: 'stale' }) + '\n',
  );

  savedEnv = {
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE,
    ARTIBOT_RUNTIME_MEMORY_DISABLE: process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE,
  };
  process.env.CLAUDE_PLUGIN_ROOT = sandboxRoot;
  process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
  process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('runtime-prompt — effort resolved before pipeline (FIX-2 ordering)', () => {
  it('runs against a sandbox that actually carries the linked modules', () => {
    // NEGATIVE CONTROL. If the links were missing, every dynamic import in the
    // hook would fall into its catch block and the assertions below would pass
    // for the wrong reason — no effort resolved looks identical to no stale
    // effort leaking. Assert the seam instead of trusting it.
    for (const dir of LINKED_DIRS) {
      expect(existsSync(path.join(sandboxRoot, dir))).toBe(true);
    }
    expect(existsSync(path.join(sandboxRoot, 'lib', 'cognitive', 'router.js'))).toBe(true);
    expect(existsSync(path.join(sandboxRoot, 'artibot.config.json'))).toBe(true);
  });

  it('overwrites the stale effort file with the current command before output', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: '/implement add oauth login',
      event: 'UserPromptSubmit',
      cwd: sandboxRoot,
    });

    expect(output).not.toBeNull();
    // Output reflects the CURRENT command, never the stale 'daily'.
    expect(output.message).toContain('cmd=/implement');
    expect(output.message).not.toContain('cmd=/daily');

    // The persisted effort file now holds the current command (write happened,
    // overwriting the seeded stale value).
    const persisted = JSON.parse(readFileSync(effortFile, 'utf-8'));
    expect(persisted.command).toBe('implement');
    expect(persisted.reason).not.toBe('stale');
  });

  it('does not leak the stale command into a non-slash prompt output', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'just answer this question directly',
      event: 'UserPromptSubmit',
      cwd: sandboxRoot,
    });

    expect(output).not.toBeNull();
    // resolveEffortMeta runs first and, for a non-command prompt, persists null
    // (no cmd= suffix) — the stale 'daily' must not surface in the output.
    expect(output.message).not.toContain('cmd=/daily');
  });
});
