/**
 * Regression tests for scripts/validate.js — locks in the three Phase 2
 * follow-up fixes:
 *   1. Extension hook events `on_handoff` / `on_llm_start` / `on_llm_end` are
 *      recognized (Artibot AD-07) and do not produce "Unknown hook event" warnings.
 *   2. `type:prompt` hook blocks are validated against a `prompt` field instead
 *      of `command` (Artibot AD-37).
 *   3. `agents/INDEX.md` (and any case variant) is skipped as a catalog file,
 *      not validated as an agent definition.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const VALIDATOR = resolve(PLUGIN_ROOT, 'scripts', 'validate.js');

function runValidator() {
  // Captures stdout+stderr; throws if exit != 0
  return execFileSync('node', [VALIDATOR], {
    cwd: PLUGIN_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('validate.js — Phase 2 follow-up fixes', () => {
  it('runs successfully against the live Artibot tree', () => {
    const output = runValidator();
    expect(output).toContain('Validation passed');
  });

  it('does not warn on extension events on_handoff / on_llm_start / on_llm_end (AD-07)', () => {
    const output = runValidator();
    expect(output).not.toMatch(/Unknown hook event:\s*"on_handoff"/);
    expect(output).not.toMatch(/Unknown hook event:\s*"on_llm_start"/);
    expect(output).not.toMatch(/Unknown hook event:\s*"on_llm_end"/);
  });

  it('does not warn about missing "command" field for Stop or UserPromptSubmit type:prompt blocks (AD-37)', () => {
    const output = runValidator();
    expect(output).not.toMatch(/\[hooks\]\s+Stop:\s+hook missing "command" field/);
    expect(output).not.toMatch(/\[hooks\]\s+UserPromptSubmit:\s+hook missing "command" field/);
  });

  it('skips agents/INDEX.md as a catalog file', () => {
    const output = runValidator();
    expect(output).not.toMatch(/\[agents\]\s+INDEX\.md\s+missing/i);
  });

  it('reports a non-zero agent count (sanity: the skip filter does not over-skip)', () => {
    const output = runValidator();
    const match = output.match(/\[agents\]\s+(\d+)\s+agent\(s\)\s+validated/);
    expect(match).not.toBeNull();
    const count = Number(match[1]);
    expect(count).toBeGreaterThan(20);
  });

  it('reports the expected counts for hooks, skills, commands, manifest', () => {
    const output = runValidator();
    expect(output).toMatch(/\[manifest\]\s+plugin\.json\s+validated/);
    expect(output).toMatch(/\[skills\]\s+\d+\/\d+\s+skill\(s\)\s+validated/);
    expect(output).toMatch(/\[commands\]\s+\d+\s+command\(s\)\s+validated/);
    expect(output).toMatch(/\[hooks\]\s+\d+\s+hook event\(s\),\s+\d+\s+hook\(s\)\s+validated/);
    expect(output).toMatch(/\[config\]\s+artibot\.config\.json\s+validated/);
  });
});
