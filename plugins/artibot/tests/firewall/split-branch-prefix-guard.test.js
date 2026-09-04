/**
 * Firewall — split limb branches must stay outside worktree-manager's reach.
 *
 * `lib/autopilot/worktree-manager.js` deletes branches on worktree removal
 * (the fix for the 393-branch leak) and guards that delete with a prefix
 * allowlist: only `autopilot/` branches are ever deleted. ADR-002 keeps that
 * module untouched and relies on `/split` limbs living under a DIFFERENT
 * prefix so the two providers cannot delete each other's branches.
 *
 * The PRD wrote the limb prefix as `split/<repo-short>/<limb>`. That was an
 * assumption. Measured 2026-08-26 21:30 KST by the leader: `claude --worktree
 * probe1` creates branch `worktree-probe1` — the built-in provider prepends
 * `worktree-` and we do not choose the branch name. The guard in
 * `lib/git/repo-identity.js` is therefore written to the measurement:
 * canonical limb branch `worktree-split-<repo-short>-<limb>`, slash variant
 * `worktree-split/…` accepted only because `/` inside a `--worktree` name is
 * unverified. Bare `split/…` is rejected — nothing the built-in provider
 * creates can look like that.
 *
 * This file pins four things:
 *   1. the accepted limb prefixes are disjoint from the autopilot prefix
 *      (read from the manager's SOURCE, so a renamed constant turns this red);
 *   2. the manager's delete path still carries the `startsWith` guard;
 *   3. the naming helpers produce the measured shape and refuse `/` and `:`;
 *   4. the SessionStart hook asks isSplitLimbBranch before relocating HEAD
 *      (gotchas #18/#22 — it relocated 4/4 limbs on 2026-09-04).
 *
 * WHAT THIS GATE DOES NOT SEE:
 *   - whether `claude --worktree` still prefixes `worktree-` in a future CLI;
 *   - whether `/` in a `--worktree` name is accepted (unverified either way);
 *   - a limb the user named by hand outside `/split`;
 *   - `EnterWorktree`'s naming, which was not measured.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_WORKTREE_BRANCH_PREFIX,
  isSplitLimbBranch,
  repoShortName,
  SPLIT_BRANCH_PREFIXES,
  SPLIT_WORKTREE_NAME_PREFIX,
  splitLimbBranch,
  splitWorktreeName,
} from '../../lib/git/repo-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(__dirname, '..', '..');
const MANAGER = path.join(PLUGIN_ROOT, 'lib', 'autopilot', 'worktree-manager.js');

// Fail-closed: a missing file or constant is a red, never a skip.
const managerSrc = readFileSync(MANAGER, 'utf-8');
const prefixMatch = /const AUTOPILOT_BRANCH_PREFIX = '([^']+)';/.exec(managerSrc);

describe('worktree-manager delete allowlist (read from source)', () => {
  it('declares a single autopilot branch prefix', () => {
    expect(prefixMatch).not.toBeNull();
    expect(prefixMatch[1]).toBe('autopilot/');
  });

  it('guards branch deletion with startsWith(AUTOPILOT_BRANCH_PREFIX)', () => {
    expect(managerSrc).toMatch(/if \(!branch\.startsWith\(AUTOPILOT_BRANCH_PREFIX\)\) return false;/);
  });
});

describe('the SessionStart hook leaves split limb branches where they are', () => {
  // Fourth pin, added 2026-09-04 after the measured incident in
  // `.artibot/split/gotchas.md` #18/#22: `git-autopilot-session.js` relocated
  // all four `/split` limbs onto `artibot/worktree-split-…`, which
  // `isSplitLimbBranch` then rejected — `status` lost every limb and `land`
  // read finished work as `no-commits`.
  //
  // Read from SOURCE rather than by calling the hook: the behavioural
  // regression lives in `tests/hooks/git-autopilot-session.test.js`, and this
  // pins the WIRING so the exception cannot be quietly reimplemented as a
  // local regex that drifts from `lib/git/repo-identity.js`.
  //
  // WHAT THIS PIN DOES NOT SEE: whether the call is reachable, whether it
  // guards the checkout rather than something else, or a rename of the
  // enclosing function. Only the behavioural test proves the branch stays.
  const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'git-autopilot-session.js');
  const hookSrc = readFileSync(HOOK, 'utf-8');

  it('imports isSplitLimbBranch from lib/git/repo-identity.js (no local copy)', () => {
    expect(hookSrc).toMatch(
      /import \{[^}]*\bisSplitLimbBranch\b[^}]*\} from '\.\.\/\.\.\/lib\/git\/repo-identity\.js';/,
    );
  });

  it('returns the current branch unchanged when it is a limb', () => {
    expect(hookSrc).toMatch(/if \(isSplitLimbBranch\(currentBranch\)\) return currentBranch;/);
  });

  it('places the exception before the checkout it has to prevent', () => {
    // Ordering is the whole point: the same call placed after `checkout -b`
    // would satisfy the pin above and prevent nothing.
    const guardAt = hookSrc.indexOf('isSplitLimbBranch(currentBranch)');
    const checkoutAt = hookSrc.indexOf("gitSilent(['checkout'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(checkoutAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(checkoutAt);
  });
});

describe('split limb prefixes are structurally disjoint from the autopilot prefix', () => {
  const autopilotPrefix = prefixMatch ? prefixMatch[1] : 'autopilot/';

  it('no accepted split prefix starts with the autopilot prefix, and vice versa', () => {
    expect(SPLIT_BRANCH_PREFIXES.length).toBeGreaterThan(0);
    for (const p of SPLIT_BRANCH_PREFIXES) {
      expect(p.startsWith(autopilotPrefix)).toBe(false);
      expect(autopilotPrefix.startsWith(p)).toBe(false);
      expect(p.startsWith(BUILTIN_WORKTREE_BRANCH_PREFIX)).toBe(true);
    }
  });

  it('a generated limb branch is never an autopilot branch', () => {
    const b = splitLimbBranch('artibot', 'auth');
    expect(b.startsWith(autopilotPrefix)).toBe(false);
    expect(isSplitLimbBranch(b)).toBe(true);
    expect(isSplitLimbBranch(`${autopilotPrefix}ap-123`)).toBe(false);
  });
});

describe('naming matches the measured built-in provider', () => {
  it('built-in prefix is worktree- (measured 2026-08-26: --worktree probe1 → worktree-probe1)', () => {
    expect(BUILTIN_WORKTREE_BRANCH_PREFIX).toBe('worktree-');
    expect(SPLIT_WORKTREE_NAME_PREFIX).toBe('split-');
  });

  it('worktree name is the hyphen form and the branch is worktree- + that name', () => {
    expect(splitWorktreeName('artibot', 'auth')).toBe('split-artibot-auth');
    expect(splitLimbBranch('artibot', 'auth')).toBe('worktree-split-artibot-auth');
    expect(splitLimbBranch('artibot', 'auth')).toBe(`${BUILTIN_WORKTREE_BRANCH_PREFIX}${splitWorktreeName('artibot', 'auth')}`);
  });

  it('the worktree name never contains / or : (slash support is unverified)', () => {
    expect(splitWorktreeName('owner/repo', 'feat:x/y')).not.toMatch(/[/:]/);
    expect(splitWorktreeName('owner/repo', 'feat:x/y')).toBe('split-owner-repo-feat-x-y');
  });

  it('repoShortName takes the name half of owner/name and the whole id for root-commit ids', () => {
    expect(repoShortName('yoodaddy0311/artibot')).toBe('artibot');
    expect(repoShortName('root-0123456789abcdef')).toBe('root-0123456789abcdef');
    expect(repoShortName('')).toBe('');
  });

  it('refuses empty segments instead of emitting a dangling prefix', () => {
    expect(() => splitWorktreeName('', 'x')).toThrow(TypeError);
    expect(() => splitWorktreeName('repo', '//')).toThrow(TypeError);
  });
});

describe('isSplitLimbBranch — allowlist, not a deny list', () => {
  it.each([
    ['worktree-split-artibot-auth', true],
    ['worktree-split/artibot/auth', true],
    ['worktree-split-', false], // prefix with nothing after it
    ['split/artibot/auth', false], // PRD's assumed form: the provider never emits it
    ['worktree-probe1', false], // a plain built-in worktree, not a limb
    ['autopilot/ap-abc123', false],
    ['master', false],
    ['', false],
    [null, false],
    [42, false],
  ])('%j → %s', (branch, expected) => {
    expect(isSplitLimbBranch(branch)).toBe(expected);
  });
});
