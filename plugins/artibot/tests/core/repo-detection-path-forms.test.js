/**
 * `isArtibotRepo` must recognise the same directory however it is spelled.
 *
 * The guard chain narrows to `security-critical` guards when the cwd is not the
 * Artibot repo (`guard-registry.js#executeChain`), so a spelling this function
 * cannot stat reads as "some other project" and silently drops the
 * `artibot-policy` guards — `sensitive-file` and `content-secret` among them.
 *
 * Measured 2026-08-30, same `.env` + AWS key write, cwd differing only in form:
 *   C:\Users\...\artibot    → block ("sensitive file")
 *   /c/Users/.../artibot    → approve      ← same directory, guard gone
 *   /tmp                    → approve      ← genuinely elsewhere, correct
 *
 * The middle row is the defect. `/c/...` is how Git Bash — the shell this repo
 * is developed in — spells a Windows path, and Node cannot stat that form, so
 * `existsSync` said "no such marker" for a directory that has both markers.
 *
 * NOT covered here: whether an unresolvable cwd should fail closed. That would
 * change what the other three callers of this function do
 * (`dev-verify-gate`, `post-write-tdd`, `stop-review-gate` all read it as
 * "should I apply Artibot-specific behaviour here?"), and it belongs to whoever
 * owns that decision, not to path spelling.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArtibotRepo } from '../../lib/core/hook-utils.js';

/** Repo root: this file is at <root>/plugins/artibot/tests/core/. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..',
);

/** `C:\Users\x` → `/c/Users/x`, the form Git Bash hands to a child process. */
function toMsysForm(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return null;
  return `/${m[1].toLowerCase()}/${m[2].split('\\').join('/')}`;
}

describe('isArtibotRepo — path spelling', () => {
  it('recognises the repo in its native form', () => {
    // Baseline. Without this the case below could pass for the wrong reason.
    expect(isArtibotRepo(REPO_ROOT)).toBe(true);
  });

  it('recognises the same directory in Git Bash form', () => {
    const msys = toMsysForm(REPO_ROOT);
    if (!msys) {
      // Non-Windows: the native form already is POSIX, nothing to translate.
      expect(isArtibotRepo(REPO_ROOT)).toBe(true);
      return;
    }
    expect(isArtibotRepo(msys)).toBe(true);
  });

  it('still says no to a directory that is genuinely not the repo', () => {
    // Over-correction guard: normalising must not make everything look like
    // the repo. The policy guards are skipped elsewhere on purpose.
    expect(isArtibotRepo(path.join(REPO_ROOT, 'plugins'))).toBe(false);
  });

  it('keeps its defensive contract for empty input', () => {
    expect(isArtibotRepo('')).toBe(false);
    expect(isArtibotRepo(null)).toBe(false);
  });
});
