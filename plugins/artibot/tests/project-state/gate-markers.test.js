import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimGateDir,
  GATE_FILES,
  GATE_STATE_KEEP_MS,
  GATES_DIR_NAME,
  gatesDir,
  NO_SESSION_SLOT,
  pruneStaleGateState,
  sessionGateDir,
  sessionIdOf,
  SESSIONS_DIR_NAME,
  sessionSlot,
  treeGateDir,
  TREES_DIR_NAME,
  treeSlot,
} from '../../lib/project-state/gate-markers.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { resolveStoreLocation } from '../../lib/project-state/store-location.js';

/**
 * lib/project-state/gate-markers.js — WHERE the gates keep their loop-guard
 * state (O2).
 *
 * The LAYOUT is pinned literally here (and in `mark-main-agent-edit.test.js`),
 * not just through the module's own functions: every reader and writer derives
 * its path from those functions, so a test that only used them could not notice
 * the whole layout moving. The cross-PROCESS claim — two hook processes agree on
 * the path, and another project's edit cannot reach this project's gate — is
 * measured with real spawns in `tests/hooks/gate-state-project-scope.test.js`.
 *
 * WHAT THIS CANNOT SEE: a real `git worktree` layout (the linked-worktree case
 * below synthesizes the pointer files git writes; the spawn suite uses real
 * ones), and pruning against a clock that really ran for 14 days (the window is
 * driven by an injected `nowMs`).
 */

const DAY = 24 * 60 * 60 * 1000;
const sha16 = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);

/** @type {string[]} */
const roots = [];

afterEach(() => {
  while (roots.length > 0) {
    try { rmSync(roots.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/**
 * @param {string} [label]
 * @returns {string} canonical temp directory
 */
function tmp(label = 'gate-markers') {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `${label}-`)));
  roots.push(dir);
  return dir;
}

/** A bare `.git` directory is all the pure-fs resolver needs. */
function repo() {
  const root = tmp('gm-repo');
  mkdirSync(path.join(root, '.git'));
  return root;
}

describe('gate-markers — the names and constants', () => {
  it('keeps the four file names exactly as they were in the plugin-root era', () => {
    // `deterministic-source` quotes `last-main-agent-edit` in a REASON that is
    // hashed into `verification_id`; the others are what every installed copy
    // and every doc already calls these files.
    expect(GATE_FILES).toEqual({
      mainAgentEdit: 'last-main-agent-edit.timestamp',
      devVerifyFingerprint: 'last-dev-verify-sha.txt',
      reviewGateFingerprint: 'last-review-gate-sha.txt',
      preWriteBlock: 'last-pre-write-block.txt',
    });
    expect(Object.isFrozen(GATE_FILES)).toBe(true);
  });

  it('pins the directory vocabulary and the retention window', () => {
    expect([GATES_DIR_NAME, SESSIONS_DIR_NAME, TREES_DIR_NAME, NO_SESSION_SLOT])
      .toEqual(['gates', 'sessions', 'trees', 'no-session']);
    expect(GATE_STATE_KEEP_MS).toBe(14 * DAY);
  });
});

describe('sessionIdOf', () => {
  it('reads session_id, then sessionId — the same rule the ledger recorder applies', () => {
    expect(sessionIdOf({ session_id: 'a', sessionId: 'b' })).toBe('a');
    expect(sessionIdOf({ sessionId: 'b' })).toBe('b');
  });

  it('skips a blank or non-string value and falls through to the next key', () => {
    expect(sessionIdOf({ session_id: '  ', sessionId: 'b' })).toBe('b');
    expect(sessionIdOf({ session_id: 7, sessionId: 'b' })).toBe('b');
  });

  it('returns null when there is nothing usable', () => {
    for (const value of [null, undefined, 'x', 42, [], {}, { session_id: '' }, { session_id: null }]) {
      expect(sessionIdOf(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('sessionSlot', () => {
  it('is the first 16 hex characters of the SHA-1 of the id', () => {
    // SHA-1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d — a published vector,
    // so the pin does not depend on this module agreeing with itself.
    expect(sessionSlot('abc')).toBe('a9993e364706816a');
    expect(sessionSlot('some-uuid-1234')).toBe(sha16('some-uuid-1234'));
  });

  it('falls back to the fixed no-session slot for anything that is not a non-blank string', () => {
    for (const value of [undefined, null, '', '   ', 0, 42, {}, []]) {
      expect(sessionSlot(value), JSON.stringify(value)).toBe(NO_SESSION_SLOT);
    }
  });

  it('can never collide with the no-session slot or carry a path separator, whatever the id says', () => {
    for (const hostile of ['../../x', '..', '.', 'a/b', 'a\\b', 'no-session', 'C:\\Windows', '\0', 'x'.repeat(10_000)]) {
      const slot = sessionSlot(hostile);
      expect(slot, hostile.slice(0, 20)).toMatch(/^[0-9a-f]{16}$/);
      expect(slot).not.toBe(NO_SESSION_SLOT);
    }
  });
});

describe('treeSlot', () => {
  it('is 16 hex characters and differs between trees', () => {
    const a = treeSlot(path.join(os.tmpdir(), 'tree-a'));
    const b = treeSlot(path.join(os.tmpdir(), 'tree-b'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it('names one tree one way however the path is spelled', () => {
    const base = path.join(os.tmpdir(), 'tree-x');
    expect(treeSlot(`${base}${path.sep}`)).toBe(treeSlot(base));
    expect(treeSlot(path.join(base, 'sub', '..'))).toBe(treeSlot(base));
  });

  it.runIf(process.platform === 'win32')('folds case on Windows, where C:\\X and c:\\x are one directory', () => {
    expect(treeSlot('C:\\Some\\Tree')).toBe(treeSlot('c:\\some\\tree'));
  });

  it.runIf(process.platform !== 'win32')('keeps case on POSIX, where two spellings are two directories', () => {
    expect(treeSlot('/Some/Tree')).not.toBe(treeSlot('/some/tree'));
  });
});

describe('gatesDir — the store rule is reused, not restated', () => {
  it('in a repository it is <git common dir>/artibot/gates', () => {
    const root = repo();
    expect(gatesDir(root)).toBe(path.join(root, '.git', 'artibot', 'gates'));
  });

  it('agrees with resolveStoreLocation for the same inputs, whatever they are', () => {
    const inRepo = repo();
    const bare = tmp('gm-bare');
    for (const root of [inRepo, bare]) {
      const { dir } = resolveStoreLocation({ projectRoot: root, gitCommonDir: resolveGitCommonDir(root) });
      expect(gatesDir(root), root).toBe(path.join(dir, 'gates'));
    }
  });

  it('outside git it is <root>/.artibot/runtime/gates (the fallback the ledger uses too)', () => {
    const root = tmp('gm-bare');
    expect(gatesDir(root)).toBe(path.join(root, '.artibot', 'runtime', 'gates'));
  });

  it('gives a linked worktree and its main checkout the SAME gates directory (F3)', () => {
    const main = repo();
    const gitdir = path.join(main, '.git', 'worktrees', 'w');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = tmp('gm-wt');
    writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);

    expect(gatesDir(wt)).toBe(gatesDir(main));
  });

  it('but keeps their sessions and their trees apart inside it', () => {
    const main = repo();
    const gitdir = path.join(main, '.git', 'worktrees', 'w');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = tmp('gm-wt');
    writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);

    expect(treeGateDir(wt)).not.toBe(treeGateDir(main));
    expect(sessionGateDir(wt, 's1')).not.toBe(sessionGateDir(wt, 's2'));
    // The same session id in two trees is ONE directory: a session is a
    // conversation, and a conversation does not belong to a tree.
    expect(sessionGateDir(wt, 's1')).toBe(sessionGateDir(main, 's1'));
  });

  it('takes the common-dir resolver as an injection seam', () => {
    const seen = [];
    const dir = gatesDir('/proj', (root) => { seen.push(root); return '/elsewhere/.git'; });
    expect(seen).toEqual(['/proj']);
    expect(dir).toBe(path.resolve('/proj', '/elsewhere/.git', 'artibot', 'gates'));
  });

  it('throws the store rule\'s own TypeError for an unusable root', () => {
    expect(() => gatesDir('')).toThrow(TypeError);
    expect(() => gatesDir(undefined)).toThrow(TypeError);
  });
});

describe('sessionGateDir / treeGateDir', () => {
  it('compose <gates>/sessions/<slot> and <gates>/trees/<slot>', () => {
    const root = repo();
    expect(sessionGateDir(root, 'abc')).toBe(path.join(
      root, '.git', 'artibot', 'gates', 'sessions', 'a9993e364706816a',
    ));
    expect(sessionGateDir(root, null)).toBe(path.join(
      root, '.git', 'artibot', 'gates', 'sessions', 'no-session',
    ));
    expect(treeGateDir(root)).toBe(path.join(
      root, '.git', 'artibot', 'gates', 'trees', treeSlot(root),
    ));
  });
});

describe('claimGateDir', () => {
  it('reports the creator exactly once and creates the parent chain', () => {
    const dir = path.join(tmp(), 'a', 'b', 'slot');
    expect(claimGateDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(claimGateDir(dir), 'the second caller found it there').toBe(false);
  });

  it('never throws — an unmakeable directory is simply "not the creator"', () => {
    const base = tmp();
    const blocker = path.join(base, 'file');
    writeFileSync(blocker, 'x');
    expect(claimGateDir(path.join(blocker, 'child', 'slot'))).toBe(false);
  });
});

describe('pruneStaleGateState', () => {
  /**
   * Plant `<gates>/<parent>/<name>/` last touched `ageMs` ago.
   * @returns {string}
   */
  function plant(gates, parent, name, ageMs, now = Date.now()) {
    const dir = path.join(gates, parent, name);
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    writeFileSync(path.join(dir, 'nested', 'f.txt'), 'x');
    const when = new Date(now - ageMs);
    utimesSync(dir, when, when);
    return dir;
  }

  it('removes slot directories idle longer than the window, in sessions/ and trees/, recursively', () => {
    const gates = path.join(tmp(), 'gates');
    const staleSession = plant(gates, 'sessions', 'a'.repeat(16), GATE_STATE_KEEP_MS + DAY);
    const staleTree = plant(gates, 'trees', 'b'.repeat(16), GATE_STATE_KEEP_MS + DAY);
    const staleNoSession = plant(gates, 'sessions', NO_SESSION_SLOT, GATE_STATE_KEEP_MS + DAY);

    expect(pruneStaleGateState(gates)).toBe(3);
    for (const dir of [staleSession, staleTree, staleNoSession]) expect(existsSync(dir), dir).toBe(false);
  });

  it('keeps everything inside the window, including a directory one second short of it', () => {
    const gates = path.join(tmp(), 'gates');
    const now = Date.now();
    const recent = plant(gates, 'sessions', 'c'.repeat(16), DAY, now);
    // One second inside, not exactly at the edge: a filesystem's timestamp
    // resolution is coarser than the comparison, so the exact boundary is not a
    // thing a test can pin without flaking.
    const nearEdge = plant(gates, 'sessions', 'd'.repeat(16), GATE_STATE_KEEP_MS - 1000, now);

    expect(pruneStaleGateState(gates, { nowMs: now })).toBe(0);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(nearEdge)).toBe(true);
  });

  it('never touches a slot named in `keep`', () => {
    const gates = path.join(tmp(), 'gates');
    const mine = plant(gates, 'sessions', 'e'.repeat(16), GATE_STATE_KEEP_MS * 5);
    const other = plant(gates, 'sessions', 'f'.repeat(16), GATE_STATE_KEEP_MS * 5);

    expect(pruneStaleGateState(gates, { keep: ['e'.repeat(16)] })).toBe(1);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it('touches only names it would have minted — anything else is left alone however old', () => {
    const gates = path.join(tmp(), 'gates');
    const foreign = ['not-a-slot', 'A'.repeat(16), 'g'.repeat(16), '0'.repeat(15), '0'.repeat(17), '.hidden'];
    const dirs = foreign.map((name) => plant(gates, 'sessions', name, GATE_STATE_KEEP_MS * 9));
    const stray = path.join(gates, 'sessions', '1'.repeat(16) + '.txt');
    writeFileSync(stray, 'x');
    const longAgo = new Date(Date.now() - GATE_STATE_KEEP_MS * 9);
    utimesSync(stray, longAgo, longAgo);
    // Something beside sessions/ and trees/ is not this module's to prune either.
    const sibling = plant(gates, 'other', '2'.repeat(16), GATE_STATE_KEEP_MS * 9);

    expect(pruneStaleGateState(gates)).toBe(0);
    for (const dir of [...dirs, sibling]) expect(existsSync(dir), dir).toBe(true);
    expect(existsSync(stray), 'a regular FILE with a slot-shaped name is not a slot').toBe(true);
  });

  it('does not delete a directory dated in the future (a clock that moved back)', () => {
    const gates = path.join(tmp(), 'gates');
    const future = plant(gates, 'sessions', '3'.repeat(16), -10 * DAY);
    expect(pruneStaleGateState(gates)).toBe(0);
    expect(existsSync(future)).toBe(true);
  });

  it('never follows or removes a link, even one old enough to be stale', () => {
    const base = tmp();
    const gates = path.join(base, 'gates');
    const outside = path.join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    mkdirSync(path.join(gates, 'sessions'), { recursive: true });
    const link = path.join(gates, 'sessions', '4'.repeat(16));
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return; // no link support on this host: nothing to assert, and nothing was deleted
    }

    // Age the WINDOW rather than the link: a fresh link is "stale" once `now` is
    // far enough ahead, so only the link rule can save it.
    const removed = pruneStaleGateState(gates, { nowMs: Date.now() + GATE_STATE_KEEP_MS * 3 });

    expect(removed).toBe(0);
    expect(existsSync(path.join(outside, 'precious.txt')), 'the link target is untouched').toBe(true);
    expect(existsSync(link), 'and so is the link itself').toBe(true);
  });

  it('treats a `keep` that is not an array as "keep nothing extra", without throwing', () => {
    const gates = path.join(tmp(), 'gates');
    const stale = plant(gates, 'sessions', '5'.repeat(16), GATE_STATE_KEEP_MS * 3);
    for (const keep of ['5'.repeat(16), null, 42, {}]) {
      // A string would make `includes` a substring test and an object would throw:
      // neither may protect or break anything.
      expect(() => pruneStaleGateState(gates, { keep })).not.toThrow();
    }
    expect(existsSync(stale)).toBe(false);
  });

  it('returns 0 and throws nothing for a missing directory or unusable arguments', () => {
    const missing = path.join(tmp(), 'no', 'such', 'gates');
    expect(pruneStaleGateState(missing)).toBe(0);
    for (const bad of [undefined, null, '', '   ', 42]) {
      expect(pruneStaleGateState(bad), JSON.stringify(bad)).toBe(0);
    }
    expect(pruneStaleGateState(missing, { nowMs: Number.NaN })).toBe(0);
    expect(pruneStaleGateState(missing, { keepMs: Number.NaN })).toBe(0);
  });
});
