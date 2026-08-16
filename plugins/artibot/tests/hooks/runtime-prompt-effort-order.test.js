/**
 * FIX-2 — effort write must precede the pipeline read (no stale off-by-one).
 *
 * runtime-prompt.js used to run fallbackPreparePrompt (whose tasks middleware
 * READS runtime/current-effort.json) BEFORE resolveEffortMeta (which WRITES
 * that file). So on prompt N the pipeline saw prompt N-1's effort. The fix
 * reorders the write ahead of the read.
 *
 * This suite runs against the REAL plugin root (the temp-dir variant cannot
 * resolve lib/cognitive/router.js, so effort never resolves there). It seeds a
 * STALE current-effort.json, fires a fresh slash command, and asserts the file
 * + output reflect the CURRENT command — never the stale one. The keystone
 * read-after-write itself is proven in
 * tests/runtime/create-artibot-agent-pluginroot.test.js.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIME_DIR = path.join(PLUGIN_ROOT, 'runtime');
const EFFORT_FILE = path.join(RUNTIME_DIR, 'current-effort.json');

// STATE-RESTORE CONTRACT. This suite must run against the REAL plugin root
// (see the module header), so handleUserPromptSubmit mutates the developer's
// own runtime/ state. Measured side effects of one run (sha256 diff of
// runtime/*, 15-file denominator): current-task-budget.json, decision-trail.json,
// token-usage-session.json, user-profile.json — on top of the seeded
// current-effort.json. Every one is saved and restored below; without that the
// suite silently overwrites whatever the developer's live session had.
// Caveat: restore is last-writer-wins, so it can only be trusted while these
// globals are not being written concurrently by another suite.
const MUTATED_RUNTIME_FILES = [
  EFFORT_FILE,
  path.join(RUNTIME_DIR, 'current-task-budget.json'),
  path.join(RUNTIME_DIR, 'decision-trail.json'),
  path.join(RUNTIME_DIR, 'token-usage-session.json'),
  path.join(RUNTIME_DIR, 'user-profile.json'),
];

describe('runtime-prompt — effort resolved before pipeline (FIX-2 ordering)', () => {
  let savedEnv;
  /** @type {Map<string, string|null>} absolute path → original content (null = absent) */
  let savedRuntime;

  beforeEach(() => {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    savedRuntime = new Map();
    for (const file of MUTATED_RUNTIME_FILES) {
      savedRuntime.set(file, existsSync(file) ? readFileSync(file, 'utf-8') : null);
    }
    // Seed a STALE effort file as if left over from a prior prompt.
    writeFileSync(
      EFFORT_FILE,
      JSON.stringify({ command: 'daily', effort: 'low', baseline: 'low', shift: 0, reason: 'stale' }) + '\n',
    );

    savedEnv = {
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE,
      ARTIBOT_RUNTIME_MEMORY_DISABLE: process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE,
    };
    process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT;
    process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
    process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Restore every runtime file the hook mutates (or remove the ones we created).
    for (const [file, original] of savedRuntime) {
      if (original === null) rmSync(file, { force: true });
      else writeFileSync(file, original);
    }
  });

  it('overwrites the stale effort file with the current command before output', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: '/implement add oauth login',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    // Output reflects the CURRENT command, never the stale 'daily'.
    expect(output.message).toContain('cmd=/implement');
    expect(output.message).not.toContain('cmd=/daily');

    // The persisted effort file now holds the current command (write happened,
    // overwriting the seeded stale value).
    const persisted = JSON.parse(readFileSync(EFFORT_FILE, 'utf-8'));
    expect(persisted.command).toBe('implement');
    expect(persisted.reason).not.toBe('stale');
  });

  it('does not leak the stale command into a non-slash prompt output', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'just answer this question directly',
      event: 'UserPromptSubmit',
    });

    expect(output).not.toBeNull();
    // resolveEffortMeta runs first and, for a non-command prompt, persists null
    // (no cmd= suffix) — the stale 'daily' must not surface in the output.
    expect(output.message).not.toContain('cmd=/daily');
  });
});
