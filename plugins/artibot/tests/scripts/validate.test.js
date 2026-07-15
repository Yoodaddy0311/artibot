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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const VALIDATOR = resolve(PLUGIN_ROOT, 'scripts', 'validate.js');

// EVERY test here cold-starts a fresh `node validate.js` subprocess via
// runValidator(). Under full-suite worker saturation that cold-start alone can
// exceed the global 30s testTimeout — previously only the first test carried a
// 60s override, leaving the other five exposed to the exact same timeout flake.
// Apply the same realistic-but-bounded 60s budget to all of them. Env headroom
// only — assertions are unchanged.
const SUBPROCESS_TIMEOUT_MS = 60_000;

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
  }, SUBPROCESS_TIMEOUT_MS);

  it('does not warn on extension events on_handoff / on_llm_start / on_llm_end (AD-07)', () => {
    const output = runValidator();
    expect(output).not.toMatch(/Unknown hook event:\s*"on_handoff"/);
    expect(output).not.toMatch(/Unknown hook event:\s*"on_llm_start"/);
    expect(output).not.toMatch(/Unknown hook event:\s*"on_llm_end"/);
  }, SUBPROCESS_TIMEOUT_MS);

  it('does not warn about missing "command" field for Stop or UserPromptSubmit type:prompt blocks (AD-37)', () => {
    const output = runValidator();
    expect(output).not.toMatch(/\[hooks\]\s+Stop:\s+hook missing "command" field/);
    expect(output).not.toMatch(/\[hooks\]\s+UserPromptSubmit:\s+hook missing "command" field/);
  }, SUBPROCESS_TIMEOUT_MS);

  it('skips agents/INDEX.md as a catalog file', () => {
    const output = runValidator();
    expect(output).not.toMatch(/\[agents\]\s+INDEX\.md\s+missing/i);
  }, SUBPROCESS_TIMEOUT_MS);

  it('reports a non-zero agent count (sanity: the skip filter does not over-skip)', () => {
    const output = runValidator();
    const match = output.match(/\[agents\]\s+(\d+)\s+agent\(s\)\s+validated/);
    expect(match).not.toBeNull();
    const count = Number(match[1]);
    expect(count).toBeGreaterThan(20);
  }, SUBPROCESS_TIMEOUT_MS);

  it('reports the expected counts for hooks, skills, commands, manifest', () => {
    const output = runValidator();
    expect(output).toMatch(/\[manifest\]\s+plugin\.json\s+validated/);
    expect(output).toMatch(/\[skills\]\s+\d+\/\d+\s+skill\(s\)\s+validated/);
    expect(output).toMatch(/\[commands\]\s+\d+\s+command\(s\)\s+validated/);
    expect(output).toMatch(/\[hooks\]\s+\d+\s+hook event\(s\),\s+\d+\s+hook\(s\)\s+validated/);
    expect(output).toMatch(/\[config\]\s+artibot\.config\.json\s+validated/);
  }, SUBPROCESS_TIMEOUT_MS);
});

describe('validate.js — command frontmatter gate (2026-07 test-gap fix)', () => {
  // Guards the strengthened validateCommands(): a stray '---' in the body must
  // NOT satisfy the gate; only a properly closed LEADING fence with a
  // description passes. Uses the ARTIBOT_COMMANDS_DIR test seam with a tmpdir
  // fixture — writing a temp file into the LIVE commands/ tree races parallel
  // test workers that count commands/*.md (observed CI flake, 2026-07-15).
  function runValidatorOnFixture(commandContent) {
    const dir = mkdtempSync(joinPath(os.tmpdir(), 'artibot-cmd-gate-'));
    writeFileSync(joinPath(dir, '__tmp-gate-check.md'), commandContent);
    try {
      execFileSync('node', [VALIDATOR], {
        cwd: PLUGIN_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ARTIBOT_COMMANDS_DIR: dir },
      });
      return { failed: false, output: '' };
    } catch (e) {
      return { failed: true, output: String(e.stdout || '') + String(e.stderr || '') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('fails (exit 1) on a command whose only "---" is a stray body fence', () => {
    const { failed, output } = runValidatorOnFixture('# no frontmatter\nbody with --- stray fence\n');
    expect(failed).toBe(true);
    expect(output).toMatch(/\[commands\]\s+__tmp-gate-check\.md\s+missing or unclosed leading YAML frontmatter block/);
  }, SUBPROCESS_TIMEOUT_MS);

  it('fails (exit 1) on a fenced command missing "description"', () => {
    const { failed, output } = runValidatorOnFixture('---\nargument-hint: "[x]"\nallowed-tools: [Read]\n---\n\n# body\n');
    expect(failed).toBe(true);
    expect(output).toMatch(/\[commands\]\s+__tmp-gate-check\.md\s+missing "description" in frontmatter/);
  }, SUBPROCESS_TIMEOUT_MS);

  it('passes a well-formed fixture command (positive seam sanity)', () => {
    const { failed } = runValidatorOnFixture('---\ndescription: ok\nargument-hint: "[x]"\nallowed-tools: [Read]\n---\n\n# body\n');
    expect(failed).toBe(false);
  }, SUBPROCESS_TIMEOUT_MS);
});
