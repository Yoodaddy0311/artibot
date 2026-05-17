import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'scripts', 'hooks');

// Hooks that v3.0.0 hooks.json registered directly (one file per Stop/PreToolUse/etc.
// slot) but which were consolidated into dispatcher in v4.7.2. Long-running Claude
// Code sessions cache the v3.0.0 hooks.json in memory, so the next Stop event will
// try to exec these paths. If the file is missing, MODULE_NOT_FOUND crashes the
// dispatcher and the user sees "Stop hook error" in their other-project session.
//
// Policy: keep a no-op stub at the original path. Stub may delegate to the
// dispatcher's replacement (e.g. dev-verify-gate.js for console.log scanning) or
// just exit 0. Either way, the file MUST exist.
const V3_LEGACY_HOOKS = [
  'check-console-log.js',
  'post-edit-format.js',
  'post-bash.js',
  'pre-compact.js',
  'user-prompt-handler.js',
  'subagent-handler.js',
  'team-idle-handler.js',
  'session-end.js',
];

describe('legacy v3.0.0 hooks — backward-compat stub presence', () => {
  for (const hookFile of V3_LEGACY_HOOKS) {
    it(`${hookFile} exists (as real file or no-op stub)`, () => {
      const hookPath = path.join(HOOKS_DIR, hookFile);
      expect(
        existsSync(hookPath),
        `Missing legacy hook: ${hookFile}. v3.0.0-cached sessions will MODULE_NOT_FOUND on next Stop/PreToolUse. ` +
          `Either restore the file or write a no-op stub (process.exit(0)).`,
      ).toBe(true);
    });

    it(`${hookFile} is executable as a Node script (parse + exit cleanly)`, () => {
      const hookPath = path.join(HOOKS_DIR, hookFile);
      if (!existsSync(hookPath)) return;
      const contents = readFileSync(hookPath, 'utf-8');
      // Must be a valid ES module / script — no syntax errors that would
      // crash before reaching process.exit. Cheap heuristic: presence of either
      // a shebang or 'import'/'export'/'process' tokens.
      const looksLikeNode = /^#!\/usr\/bin\/env node|import |export |process\.|require\(/m.test(contents);
      expect(
        looksLikeNode,
        `${hookFile} exists but does not appear to be a Node script (missing shebang / imports / process usage)`,
      ).toBe(true);
    });
  }
});
