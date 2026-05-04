/**
 * Tests for scripts/ci/validate-hooks.js
 * Validates hook type handling: "command" hooks require "command" field,
 * "prompt" hooks require "prompt" field.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const VALIDATOR = resolve(PLUGIN_ROOT, 'scripts', 'ci', 'validate-hooks.js');
const HOOKS_PATH = resolve(PLUGIN_ROOT, 'hooks', 'hooks.json');

function runValidator() {
  return execFileSync('node', [VALIDATOR], {
    cwd: PLUGIN_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('validate-hooks.js', () => {
  it('passes validation on current hooks.json', () => {
    const output = runValidator();
    expect(output).toContain('validated successfully');
  });

  it('accepts type:prompt hooks without command field', () => {
    const output = runValidator();
    // Should not report missing "command" for prompt-type hooks
    expect(output).not.toContain('missing "command"');
  });

  it('validates all expected hook events', () => {
    const output = runValidator();
    const expectedEvents = [
      'SessionStart', 'PreToolUse', 'PostToolUse', 'PreCompact',
      'Stop', 'UserPromptSubmit', 'SessionEnd', 'InstructionsLoaded',
    ];
    for (const event of expectedEvents) {
      expect(output).toContain(`PASS: hooks.${event}`);
    }
  });
});

describe('validate-hooks.js — type:prompt field logic', () => {
  let hooks;

  it('hooks.json is valid JSON', () => {
    hooks = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'));
    expect(hooks.hooks).toBeDefined();
  });

  it('all type:prompt hooks have a prompt field', () => {
    for (const [event, entries] of Object.entries(hooks.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          if (hook.type === 'prompt') {
            expect(hook.prompt, `${event} prompt hook missing prompt field`).toBeTruthy();
          }
        }
      }
    }
  });

  it('all type:command hooks have a command field', () => {
    for (const [event, entries] of Object.entries(hooks.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          if (hook.type === 'command') {
            expect(hook.command, `${event} command hook missing command field`).toBeTruthy();
          }
        }
      }
    }
  });
});
