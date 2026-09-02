/**
 * The `--force-with-lease` exemption must not travel outside the rules it was
 * written for.
 *
 * `SAFE_OVERRIDES` was introduced so a genuinely safe force push
 * (`git push --force-with-lease`) is not blocked alongside `git push --force`.
 * It was applied inside the loop over EVERY blocked pattern and tested against
 * the whole command string, so appending that token to any command at all
 * skipped the entire denylist. Measured 2026-08-30 against the real hook:
 * `rm -rf /` blocked, `rm -rf / --force-with-lease` allowed. The flag means
 * nothing to `rm`, so it costs an attacker nothing to add.
 *
 * The exemption is therefore attached to the two `git push` rules that need it
 * (`lib/core/blocked-patterns.js`) rather than living as a global list. Category
 * alone would not have been enough: `--force-with-lease` is equally meaningless
 * to `git reset --hard`, which is also in the `git` category.
 *
 * SCOPE: this file pins the exemption's reach only. The denylist remains a
 * denylist — semantically equivalent commands (`rm -rf ~`, `find / -delete`)
 * still pass, and nothing here should be read as covering that.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  executeChain,
  registerBuiltinGuards,
  resetGuards,
} from '../../lib/core/guard-registry.js';

beforeEach(() => {
  resetGuards();
  registerBuiltinGuards();
});

/**
 * @param {string} command
 * @returns {{ decision: string, reason?: string }}
 */
function judge(command) {
  return executeChain(
    'pre',
    'Bash',
    { tool_name: 'Bash', tool_input: { command } },
    { cwd: '/tmp' },
  );
}

describe('dangerous-command — exemption scope', () => {
  it('blocks the commands the denylist names', () => {
    // Baseline. If these ever stop blocking, the cases below prove nothing.
    expect(judge('rm -rf /').decision).toBe('block');
    expect(judge('git reset --hard').decision).toBe('block');
    expect(judge('git push --force origin main').decision).toBe('block');
  });

  it('does not let a git flag exempt a filesystem command', () => {
    const r = judge('rm -rf / --force-with-lease');
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('rm -rf with path');
  });

  it('does not let the exemption travel to other git rules', () => {
    // Same category, but the flag is meaningless here — a category-wide
    // exemption would have let this through.
    expect(judge('git reset --hard --force-with-lease').decision).toBe('block');
    expect(judge('git clean -fd --force-if-includes').decision).toBe('block');
  });

  it('still allows the safe force push the exemption exists for', () => {
    // Over-correction guard: the point was never to block these.
    expect(judge('git push --force-with-lease origin main').decision).not.toBe('block');
    expect(judge('git push --force-if-includes origin main').decision).not.toBe('block');
  });
});
