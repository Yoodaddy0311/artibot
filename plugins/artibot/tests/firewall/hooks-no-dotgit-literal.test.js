/**
 * Firewall — no hook may join `'.git'` by hand.
 *
 * Ratchet at zero. Its job is to make PARTIAL adoption impossible, which is the
 * failure mode that actually hurts: if one hook resolves the git dir properly
 * and another still joins `'.git'`, a worktree session writes its state to the
 * real per-worktree git dir and reads it back from `<worktree>/.git/...`, a path
 * that cannot exist because `<worktree>/.git` is a pointer file. The two halves
 * then disagree about where state lives, which is worse than both being wrong:
 * setup appears to succeed and every later read comes back empty.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - Registration and firing. A hook can be absent from `hooks/hooks.json`, or
 *     registered and never invoked, and this stays green. Existence is not
 *     operation; a passing scan says only that the source does not spell the
 *     literal.
 *   - Runtime correctness. `gitPath` could resolve to the wrong directory and
 *     this gate would not notice — `worktree-gitdir-resolution.test.js` covers
 *     that, and only for the resolver, not for each hook's own read path.
 *   - Other spellings. A hook that builds the path from a variable, a template
 *     literal, or `'.' + 'git'` slips through. The scan is deliberately literal;
 *     it raises the cost of the obvious regression, not of a determined one.
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'scripts', 'hooks',
);

/** `path.join(x, '.git', …)` and friends — a quoted `.git` path segment. */
const DOTGIT_LITERAL = /(['"])\.git\1/;

function hookFiles() {
  return fsSync.readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

function offendingLines(file) {
  const source = fsSync.readFileSync(path.join(HOOKS_DIR, file), 'utf-8');
  return source.split(/\r?\n/)
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter(({ text }) => DOTGIT_LITERAL.test(text));
}

describe('hooks must resolve the git dir, never join .git literally', () => {
  it('scans a non-empty set of hook files (self-check)', () => {
    // A scanner that silently found nothing to scan would pass forever.
    const files = hookFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('git-autopilot-save.js');
    expect(files).toContain('git-autopilot-session.js');
  });

  it('detects the literal when it is present (self-check)', () => {
    // Proves the regex is not vacuous, without needing a fixture on disk.
    expect(DOTGIT_LITERAL.test("path.join(repoRoot, '.git', 'autopilot.json')")).toBe(true);
    expect(DOTGIT_LITERAL.test('path.join(repoRoot, ".git", "x.json")')).toBe(true);
    expect(DOTGIT_LITERAL.test("gitPath(repoRoot, 'autopilot.json')")).toBe(false);
    expect(DOTGIT_LITERAL.test('// mentions .git in prose')).toBe(false);
  });

  it('finds zero literal .git joins across scripts/hooks', () => {
    const found = [];
    for (const file of hookFiles()) {
      for (const { line, text } of offendingLines(file)) {
        found.push(`${file}:${line}  ${text}`);
      }
    }
    expect(found).toEqual([]);
  });
});
