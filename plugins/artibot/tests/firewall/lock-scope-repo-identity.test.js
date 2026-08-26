/**
 * Firewall — the autopilot feature lock must be scoped by repository identity.
 *
 * The lock file was keyed by the task slug alone (`lock.js#getLockPath`, the
 * PRD's F3). Two consequences, both wrong in opposite directions:
 *   - two clones of DIFFERENT repositories running the same task collided on
 *     one file and serialised for no reason;
 *   - two runs in the SAME repository with different slugs never saw each
 *     other (that half is `preflight.js#repoConcurrency`, tested in
 *     tests/autopilot/preflight.test.js).
 *
 * This file drives the real `lock.js` and the real `lib/git/repo-identity.js`
 * against temp repositories: identity comes from the remote (lower-cased,
 * URL-form independent), falls back to the root commit when there is no
 * remote, is the same from a linked worktree, and is `null` outside a repo.
 * With the identity passed to the lock, the acceptance line reads exactly as
 * the PRD states it: "두 리포 같은 키 락 모두 성공 / 같은 리포 직렬화".
 *
 * Reversibility is asserted, not assumed: a live lock written under the OLD
 * unscoped scheme blocks a scoped acquire and is reported with
 * `scheme:'legacy'`, so rolling back to unscoped keys reads exactly the files
 * old code always read. A stale legacy file must NOT block (and is left on
 * disk — not ours to reclaim).
 *
 * Separation from the security gate: `lib/autopilot/repo-identity.js`
 * (`isAutopilotAllowed`) is untouched. Its source must not import `lib/git/`,
 * its normaliser must agree with ours on the four canonical URL forms, and a
 * non-allowlisted temp repo must still be refused.
 *
 * WHAT THIS GATE DOES NOT SEE:
 *   - engine.js does not yet pass `repoIdentity` to `acquireLock`; until that
 *     call site is wired the scoped path is capability, not behaviour.
 *   - Cross-process races between the legacy read and the scoped O_EXCL
 *     write (two steps by design; see lock.js header).
 *   - Multi-root repositories beyond "lexically smallest root wins".
 *   - A user's own `~/.claude/artibot/autopilot-allowlist.json` — the gate
 *     assertion only checks a repo that is on NO allowlist.
 *
 * The lock store is redirected to a temp dir via CLAUDE_PLUGIN_ROOT (read at
 * call time by `getPluginRoot`), so nothing under `runtime/` is touched.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireLock,
  getLockKey,
  getLockPath,
  isLocked,
  listLocks,
  readLegacyLock,
  readLock,
  releaseLock,
} from '../../lib/autopilot/lock.js';
import {
  composeScopedKey,
  getRepoIdentity,
  normalizeRemoteUrl,
  resolveRepoIdentity,
  sanitizeSegment,
} from '../../lib/git/repo-identity.js';
import {
  isAutopilotAllowed,
  normalizeRepoId,
} from '../../lib/autopilot/repo-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(__dirname, '..', '..');

const ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;

let sandbox = '';
let store = '';
let repoA = '';
let repoAWorktree = '';
let repoB = '';
let repoNoRemote = '';
let repoUnborn = '';
let notARepo = '';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

function initRepo(dir, { remote, commit = true } = {}) {
  fsSync.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', '.'], dir);
  git(['config', 'user.email', 'test@example.invalid'], dir);
  git(['config', 'user.name', 'test'], dir);
  if (remote) git(['remote', 'add', 'origin', remote], dir);
  if (commit) {
    fsSync.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n', 'utf-8');
    git(['add', 'seed.txt'], dir);
    git(['commit', '-qm', 'init'], dir);
  }
}

beforeAll(() => {
  sandbox = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-lockscope-'));
  store = path.join(sandbox, 'plugin-root');
  fsSync.mkdirSync(store, { recursive: true });
  process.env.CLAUDE_PLUGIN_ROOT = store;

  repoA = path.join(sandbox, 'repo-a');
  initRepo(repoA, { remote: 'https://github.com/Example/Repo-A.git' });
  repoAWorktree = path.join(sandbox, 'repo-a-limb');
  git(['worktree', 'add', '-q', repoAWorktree, '-b', 'worktree-split-repo-a-limb'], repoA);

  repoB = path.join(sandbox, 'repo-b');
  initRepo(repoB, { remote: 'git@github.com:Other/repo-b.git' });

  repoNoRemote = path.join(sandbox, 'repo-no-remote');
  initRepo(repoNoRemote);

  repoUnborn = path.join(sandbox, 'repo-unborn');
  initRepo(repoUnborn, { commit: false });

  notARepo = path.join(sandbox, 'plain-dir');
  fsSync.mkdirSync(notARepo, { recursive: true });
});

afterAll(() => {
  if (ORIGINAL_PLUGIN_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
  try {
    fsSync.rmSync(sandbox, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('store redirection (precondition for every write below)', () => {
  it('writes lock files under the temp plugin root, never under the real runtime/', () => {
    const p = getLockPath('probe');
    expect(path.normalize(p).startsWith(path.normalize(store))).toBe(true);
    expect(path.normalize(p).startsWith(path.normalize(path.join(PLUGIN_ROOT, 'runtime')))).toBe(false);
  });
});

describe('lib/git/repo-identity — resolution', () => {
  it('derives owner/name from the remote, lower-cased', () => {
    const r = resolveRepoIdentity(repoA);
    expect(r).toMatchObject({ id: 'example/repo-a', source: 'remote' });
    expect(r.gitDir).toBeTruthy();
  });

  it('is URL-form independent: https and git@ forms of one repo agree with the gate normaliser', () => {
    const forms = [
      'https://github.com/Yoodaddy0311/artibot.git',
      'https://user@github.com/Yoodaddy0311/artibot.git',
      'git@github.com:Yoodaddy0311/artibot.git',
      'ssh://git@github.com/Yoodaddy0311/artibot.git',
    ];
    for (const u of forms) {
      expect(normalizeRemoteUrl(u)).toBe('Yoodaddy0311/artibot');
      // Two normalisers, one rule — drift here is the thing this line catches.
      expect(normalizeRemoteUrl(u)).toBe(normalizeRepoId(u));
    }
  });

  it('is the same from a linked worktree as from the main checkout', () => {
    expect(getRepoIdentity(repoAWorktree)).toBe(getRepoIdentity(repoA));
    expect(getRepoIdentity(repoAWorktree)).toBe('example/repo-a');
  });

  it('differs between unrelated repositories', () => {
    expect(getRepoIdentity(repoB)).toBe('other/repo-b');
    expect(getRepoIdentity(repoB)).not.toBe(getRepoIdentity(repoA));
  });

  it('falls back to the root commit SHA when there is no remote', () => {
    const root = git(['rev-list', '--max-parents=0', 'HEAD'], repoNoRemote);
    const r = resolveRepoIdentity(repoNoRemote);
    expect(r.source).toBe('root-commit');
    expect(r.id).toBe(`root-${root.slice(0, 16)}`);
    expect(r.remote).toBe('');
  });

  it('returns null for an unborn HEAD and outside a repository — never invents an id', () => {
    expect(resolveRepoIdentity(repoUnborn)).toMatchObject({ id: null, source: 'none' });
    expect(resolveRepoIdentity(notARepo)).toMatchObject({ id: null, source: 'none', gitDir: null });
    expect(getRepoIdentity('')).toBeNull();
    expect(getRepoIdentity(undefined)).toBeNull();
  });
});

describe('scoped key composition — single string, sanitised', () => {
  it('composes ${identity}__${featureKey} with / and : replaced', () => {
    expect(composeScopedKey('example/repo-a', 'auth:login')).toBe('example-repo-a__auth-login');
    expect(getLockKey('auth:login', { repoIdentity: 'example/repo-a' })).toBe('example-repo-a__auth-login');
  });

  it('keeps Korean feature keys intact (extractKey output is a supported input)', () => {
    expect(sanitizeSegment('로그인-기능')).toBe('로그인-기능');
    expect(composeScopedKey('example/repo-a', '로그인-기능')).toBe('example-repo-a__로그인-기능');
  });

  it('never yields a path traversal segment', () => {
    expect(sanitizeSegment('..')).toBe('');
    expect(sanitizeSegment('../x')).toBe('x');
    expect(() => composeScopedKey('..', 'x')).toThrow(TypeError);
  });

  it('is byte-identical to the legacy path when no identity is given', () => {
    expect(getLockKey('feature-x')).toBe('feature-x');
    expect(getLockPath('feature-x')).toBe(path.join(store, 'runtime', 'autopilot', 'locks', 'feature-x.lock'));
  });
});

describe('acceptance — 두 리포 같은 키 모두 성공 / 같은 리포 직렬화', () => {
  const key = 'shared-task';

  it('two DIFFERENT repositories acquire the same feature key independently', () => {
    const idA = getRepoIdentity(repoA);
    const idB = getRepoIdentity(repoB);
    const a = acquireLock(key, 'sess-a', { repoIdentity: idA, cwd: repoA });
    const b = acquireLock(key, 'sess-b', { repoIdentity: idB, cwd: repoB });
    try {
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(a.lockPath).not.toBe(b.lockPath);
      for (const p of [a.lockPath, b.lockPath]) {
        const stem = path.basename(p, '.lock');
        expect(stem).not.toMatch(/[/:\\]/);
        expect(stem).toContain('__');
      }
      const holder = readLock(key, { repoIdentity: idA });
      expect(holder).toMatchObject({ featureKey: key, repoIdentity: idA, cwd: repoA, lockKey: 'example-repo-a__shared-task' });
    } finally {
      releaseLock(key, 'sess-a', { repoIdentity: idA });
      releaseLock(key, 'sess-b', { repoIdentity: idB });
    }
  });

  it('the SAME repository (main checkout vs linked worktree) serialises on one file', () => {
    const idMain = getRepoIdentity(repoA);
    const idLimb = getRepoIdentity(repoAWorktree);
    const first = acquireLock(key, 'sess-main', { repoIdentity: idMain, cwd: repoA });
    try {
      expect(first.ok).toBe(true);
      const second = acquireLock(key, 'sess-limb', { repoIdentity: idLimb, cwd: repoAWorktree });
      expect(second.ok).toBe(false);
      expect(second.holder.sessionId).toBe('sess-main');
      expect(second.lockPath).toBe(first.lockPath);
      const state = isLocked(key, { repoIdentity: idLimb });
      expect(state).toMatchObject({ locked: true, scheme: 'scoped' });
    } finally {
      releaseLock(key, 'sess-main', { repoIdentity: idMain });
    }
    expect(acquireLock(key, 'sess-limb', { repoIdentity: idLimb }).ok).toBe(true);
    expect(releaseLock(key, 'sess-limb', { repoIdentity: idLimb })).toBe(true);
  });

  it('listLocks exposes the identity so preflight can attribute peers', () => {
    const id = getRepoIdentity(repoA);
    acquireLock('other-task', 'sess-list', { repoIdentity: id, cwd: repoA });
    try {
      const mine = listLocks().filter((l) => l.holder.sessionId === 'sess-list');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ lockKey: 'example-repo-a__other-task', stale: false });
      expect(mine[0].holder).toMatchObject({ repoIdentity: id, featureKey: 'other-task', cwd: repoA });
    } finally {
      releaseLock('other-task', 'sess-list', { repoIdentity: id });
    }
  });
});

describe('parallel legacy reader — old-scheme files stay authoritative', () => {
  const key = 'legacy-task';
  const id = 'example/repo-a';

  function forgeLegacy(over) {
    const p = getLockPath(key);
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    fsSync.writeFileSync(p, JSON.stringify({
      pid: process.pid, sessionId: 'pre-upgrade', acquiredAt: Date.now(), featureKey: key, ...over,
    }), 'utf-8');
    return p;
  }

  it('a LIVE unscoped lock blocks a scoped acquire and is reported as scheme:legacy', () => {
    const legacyPath = forgeLegacy({});
    try {
      const r = acquireLock(key, 'sess-new', { repoIdentity: id });
      expect(r.ok).toBe(false);
      expect(r.scheme).toBe('legacy');
      expect(r.holder.sessionId).toBe('pre-upgrade');
      expect(fsSync.existsSync(getLockPath(key, { repoIdentity: id }))).toBe(false);

      const state = isLocked(key, { repoIdentity: id });
      expect(state).toMatchObject({ locked: true, stale: false, scheme: 'legacy' });
      expect(readLegacyLock(key).sessionId).toBe('pre-upgrade');
      // The scoped view alone is empty — the reader, not the key, found it.
      expect(readLock(key, { repoIdentity: id })).toBeNull();
    } finally {
      fsSync.unlinkSync(legacyPath);
    }
  });

  it('a STALE unscoped lock (dead pid) does not block, and is left on disk', () => {
    const legacyPath = forgeLegacy({ pid: 99999999 });
    try {
      const r = acquireLock(key, 'sess-new', { repoIdentity: id });
      expect(r.ok).toBe(true);
      expect(fsSync.existsSync(legacyPath)).toBe(true);
      expect(releaseLock(key, 'sess-new', { repoIdentity: id })).toBe(true);
      // A scoped release never touches the legacy file.
      expect(fsSync.existsSync(legacyPath)).toBe(true);
    } finally {
      fsSync.unlinkSync(legacyPath);
    }
  });

  it('unscoped callers see exactly what they always saw (scheme:legacy, same file)', () => {
    const r = acquireLock(key, 'sess-old');
    try {
      expect(r.lockPath).toBe(getLockPath(key));
      expect(isLocked(key)).toMatchObject({ locked: true, scheme: 'legacy' });
      expect(readLock(key)).toMatchObject({ featureKey: key, lockKey: key });
      expect(readLock(key).repoIdentity).toBeUndefined();
    } finally {
      releaseLock(key, 'sess-old');
    }
  });
});

describe('security gate untouched — isAutopilotAllowed has not regressed', () => {
  it('refuses a temp repo whose remote is on no allowlist', () => {
    expect(isAutopilotAllowed(repoA)).toBe(false);
    expect(isAutopilotAllowed(repoNoRemote)).toBe(false);
    expect(isAutopilotAllowed(notARepo)).toBe(false);
  });

  it('the gate module does not import lib/git (separation is structural, not stylistic)', () => {
    const src = fsSync.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'autopilot', 'repo-identity.js'), 'utf-8');
    expect(src).not.toMatch(/from\s+['"]\.\.\/git\//);
    expect(src).toMatch(/export function isAutopilotAllowed\(/);
  });

  it('the observational module does not import lib/autopilot', () => {
    const src = fsSync.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'git', 'repo-identity.js'), 'utf-8');
    expect(src).not.toMatch(/from\s+['"]\.\.\/autopilot\//);
  });
});
