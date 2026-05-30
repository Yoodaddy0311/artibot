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
const EFFORT_FILE = path.join(PLUGIN_ROOT, 'runtime', 'current-effort.json');

describe('runtime-prompt — effort resolved before pipeline (FIX-2 ordering)', () => {
  let savedEnv;
  let hadEffortFile;
  let savedEffort;

  beforeEach(() => {
    mkdirSync(path.join(PLUGIN_ROOT, 'runtime'), { recursive: true });
    hadEffortFile = existsSync(EFFORT_FILE);
    savedEffort = hadEffortFile ? readFileSync(EFFORT_FILE, 'utf-8') : null;
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
    // Restore the original effort file (or remove the one we seeded).
    if (hadEffortFile) writeFileSync(EFFORT_FILE, savedEffort);
    else rmSync(EFFORT_FILE, { force: true });
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
