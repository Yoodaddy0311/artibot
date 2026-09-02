/**
 * Tests for lib/handoff/handoff-store.js
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _internals,
  checkHandoffTrackedIntegrity,
  listHandoffs,
  pruneHandoffs,
  readLatestHandoff,
  writeHandoff,
} from '../../lib/handoff/handoff-store.js';

const { POINTER_REL, ARCHIVE_DIR, parseArchiveStamp, parsePorcelainZ } = _internals;

function makeTempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'handoff-store-'));
}

// ---------------------------------------------------------------------------
// Git fixture helpers — a real `git init` in a temp dir. os.tmpdir() must be
// outside any work tree for the probes to answer for the fixture only; the
// non-git suites below additionally inject a throwing `exec` so they stay
// hermetic even on a host where that does not hold.
// ---------------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function makeGitRoot() {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'handoff-git-')));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'core.autocrlf', 'false');
  return root;
}

/** Write archive files under .artibot/handoffs and return their absolute paths. */
function seedArchives(root, names) {
  const dir = path.join(root, ARCHIVE_DIR);
  mkdirSync(dir, { recursive: true });
  return names.map((n) => {
    const p = path.join(dir, n);
    writeFileSync(p, `# ${n}\n`, 'utf8');
    return p;
  });
}

function commitArchives(root) {
  git(root, 'add', '--', '.artibot/handoffs');
  git(root, 'commit', '-q', '-m', 'seed tracked archives');
}

function porcelain(root) {
  return git(root, 'status', '--porcelain', '--', '.artibot/handoffs').split(/\r?\n/).filter(Boolean);
}

/** exec stub that behaves like a host with no git binary at all. */
function noGitExec() {
  throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
}

describe('handoff-store / writeHandoff', () => {
  let root;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates both HANDOFF.md pointer and an archive copy', async () => {
    const md = '# HANDOFF\n\nbody\n';
    const res = await writeHandoff(md, { projectRoot: root, now: () => new Date(2026, 4, 19, 12, 30) });

    expect(existsSync(path.join(root, POINTER_REL))).toBe(true);
    expect(existsSync(res.archivePath)).toBe(true);
    expect(readFileSync(res.latestPath, 'utf8')).toBe(md);
    expect(readFileSync(res.archivePath, 'utf8')).toBe(md);
  });

  it('rotates older archives when keep is exceeded', async () => {
    // Write 4 archives with distinct timestamps (minute apart). throttleMs=0
    // disables the v4.13.0 throttle so each write produces a fresh archive.
    for (let i = 0; i < 4; i += 1) {
      await writeHandoff(`# H${i}\n`, {
        projectRoot: root,
        keep: 99,
        throttleMs: 0,
        now: () => new Date(2026, 4, 19, 12, i, 0),
      });
    }
    let list = await listHandoffs(root);
    expect(list.length).toBe(4);

    // Now write one more with keep=2 → should prune down to 2 newest
    await writeHandoff('# H4\n', {
      projectRoot: root,
      keep: 2,
      throttleMs: 0,
      now: () => new Date(2026, 4, 19, 12, 4, 0),
    });
    list = await listHandoffs(root);
    expect(list.length).toBe(2);
    // Pointer is untouched
    expect(existsSync(path.join(root, POINTER_REL))).toBe(true);
  });

  it('appends -2 suffix on filename collision within the same minute', async () => {
    const stamp = () => new Date(2026, 4, 19, 12, 30, 0);
    const r1 = await writeHandoff('# A\n', { projectRoot: root, throttleMs: 0, now: stamp });
    const r2 = await writeHandoff('# B\n', { projectRoot: root, throttleMs: 0, now: stamp });

    expect(r1.archivePath).not.toBe(r2.archivePath);
    expect(path.basename(r2.archivePath)).toMatch(/-2\.md$/);
  });

  it('return shape carries the additive git fields with legacy defaults outside a repo', async () => {
    const res = await writeHandoff('# shape\n', { projectRoot: root, now: () => new Date(2026, 4, 19, 12, 30) });
    expect(Object.keys(res).sort()).toEqual(
      ['archivePath', 'latestPath', 'protectedTracked', 'pruneSkipped', 'pruned', 'throttled'],
    );
    expect(res.protectedTracked).toBe(0);
    expect(res.pruneSkipped).toBeNull();
  });
});

describe('handoff-store / readLatestHandoff', () => {
  let root;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns null when pointer file is missing', async () => {
    const out = await readLatestHandoff(root);
    expect(out).toBeNull();
  });

  it('returns { path, content, mtime } when pointer exists', async () => {
    await writeHandoff('# X\n', { projectRoot: root, now: () => new Date(2026, 4, 19, 13, 0) });
    const out = await readLatestHandoff(root);
    expect(out).not.toBeNull();
    expect(out.content).toBe('# X\n');
    expect(out.path).toBe(path.join(root, POINTER_REL));
    expect(typeof out.mtime).toBe('number');
  });
});

describe('handoff-store / throttle (Safety #4)', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
    delete process.env.ARTIBOT_HANDOFF_THROTTLE_MS;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.ARTIBOT_HANDOFF_THROTTLE_MS;
  });

  it('throttle window: in-place overwrite when previous archive is within window', async () => {
    // 1st write at T+0
    const first = await writeHandoff('# v1\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000, // 10m
      now: () => new Date(2026, 4, 19, 12, 0, 0),
    });
    const listAfterFirst = await listHandoffs(root);
    expect(listAfterFirst.length).toBe(1);

    // 2nd write at T+5m → still inside the 10m window → throttle
    const second = await writeHandoff('# v2\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 5, 0),
    });
    expect(second.throttled).toBe(true);
    expect(second.pruned).toBe(0);
    expect(second.archivePath).toBe(first.archivePath);

    // Archive directory size unchanged; archive content matches latest
    const listAfterSecond = await listHandoffs(root);
    expect(listAfterSecond.length).toBe(1);
    expect(readFileSync(second.archivePath, 'utf8')).toBe('# v2\n');
    // Pointer always refreshed
    expect(readFileSync(second.latestPath, 'utf8')).toBe('# v2\n');
  });

  it('throttleMs=0 disables throttling — every call creates a fresh archive', async () => {
    const r1 = await writeHandoff('# a\n', {
      projectRoot: root,
      throttleMs: 0,
      now: () => new Date(2026, 4, 19, 12, 0, 0),
    });
    const r2 = await writeHandoff('# b\n', {
      projectRoot: root,
      throttleMs: 0,
      now: () => new Date(2026, 4, 19, 12, 1, 0),
    });
    expect(r1.throttled).toBe(false);
    expect(r2.throttled).toBe(false);
    expect(r1.archivePath).not.toBe(r2.archivePath);
    const list = await listHandoffs(root);
    expect(list.length).toBe(2);
  });

  it('empty archive dir: throttle has nothing to fold into → normal new-file path', async () => {
    const res = await writeHandoff('# fresh\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 0, 0),
    });
    expect(res.throttled).toBe(false);
    expect(existsSync(res.archivePath)).toBe(true);
    const list = await listHandoffs(root);
    expect(list.length).toBe(1);
  });

  it('window is anchored to the archive stamp: a burst longer than throttleMs rolls into a new file', async () => {
    const opts = (m) => ({ projectRoot: root, throttleMs: 10 * 60_000, now: () => new Date(2026, 4, 19, 12, m, 0) });
    const r0 = await writeHandoff('# 0\n', opts(0));
    const r9 = await writeHandoff('# 9\n', opts(9));
    const r11 = await writeHandoff('# 11\n', opts(11));
    expect(r9.throttled).toBe(true);
    expect(r9.archivePath).toBe(r0.archivePath);
    expect(r11.throttled).toBe(false);
    expect(path.basename(r11.archivePath)).toBe('2026-05-19-1211.md');
  });
});

describe('handoff-store / pruneHandoffs', () => {
  let root;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('keep=0 removes all archives but preserves pointer', async () => {
    for (let i = 0; i < 3; i += 1) {
      await writeHandoff(`# H${i}\n`, {
        projectRoot: root,
        keep: 99,
        throttleMs: 0,
        now: () => new Date(2026, 4, 19, 12, i, 0),
      });
    }
    const before = await listHandoffs(root);
    expect(before.length).toBe(3);
    expect(existsSync(path.join(root, POINTER_REL))).toBe(true);

    const result = await pruneHandoffs(root, { keep: 0 });
    expect(result.removed).toBe(3);

    const after = await listHandoffs(root);
    expect(after.length).toBe(0);
    // Pointer preserved
    expect(existsSync(path.join(root, POINTER_REL))).toBe(true);
    // Archive dir may still exist
    expect(existsSync(path.join(root, ARCHIVE_DIR))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Git-tracked archive protection (P0: /save clobbered / pruned committed
// handoffs in fresh worktrees where every tracked file has a fresh mtime)
// ---------------------------------------------------------------------------

describe('handoff-store / git-tracked protection', () => {
  let root;

  beforeEach(() => {
    root = makeGitRoot();
    delete process.env.ARTIBOT_HANDOFF_THROTTLE_MS;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('tracked archive inside the throttle window is NOT reused — a fresh untracked file is created', async () => {
    // Stamp is 5 minutes before `now`, file was just checked out (fresh mtime):
    // the pre-fix store overwrote it in place (` M` in git status).
    const [trackedPath] = seedArchives(root, ['2026-05-19-1200.md']);
    commitArchives(root);
    expect(porcelain(root)).toEqual([]);

    const res = await writeHandoff('# new session\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 5, 0),
    });

    expect(res.throttled).toBe(false);
    expect(res.archivePath).not.toBe(trackedPath);
    expect(path.basename(res.archivePath)).toBe('2026-05-19-1205.md');
    expect(res.protectedTracked).toBeGreaterThanOrEqual(1);
    expect(res.pruneSkipped).toBeNull();
    expect(readFileSync(trackedPath, 'utf8')).toBe('# 2026-05-19-1200.md\n');
    // Only the new file shows up, and only as untracked.
    expect(porcelain(root)).toEqual(['?? .artibot/handoffs/2026-05-19-1205.md']);
  });

  it('untracked archive this store created is still reused inside the window (throttle preserved in repos)', async () => {
    seedArchives(root, ['2026-05-19-1100.md']);
    commitArchives(root);
    const first = await writeHandoff('# v1\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 0, 0),
    });
    const second = await writeHandoff('# v2\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 5, 0),
    });
    expect(first.throttled).toBe(false);
    expect(second.throttled).toBe(true);
    expect(second.archivePath).toBe(first.archivePath);
    expect(second.protectedTracked).toBe(1);
    expect(porcelain(root)).toEqual(['?? .artibot/handoffs/2026-05-19-1200.md']);
  });

  it('prune never deletes tracked archives beyond keep; untracked ones beyond keep are deleted', async () => {
    // 3 tracked (older) + 3 untracked (newer). keep=2 keeps the two newest
    // untracked, deletes the third untracked, and leaves all 3 tracked alone.
    seedArchives(root, ['2026-01-01-0100.md', '2026-01-02-0100.md', '2026-01-03-0100.md']);
    commitArchives(root);
    seedArchives(root, ['2026-02-01-0100.md', '2026-02-02-0100.md', '2026-02-03-0100.md']);

    const result = await pruneHandoffs(root, { keep: 2 });

    expect(result).toEqual({ removed: 1, protectedTracked: 3, skipped: null });
    const remaining = (await listHandoffs(root)).map((r) => r.filename).sort();
    expect(remaining).toEqual([
      '2026-01-01-0100.md', '2026-01-02-0100.md', '2026-01-03-0100.md',
      '2026-02-02-0100.md', '2026-02-03-0100.md',
    ]);
    expect(porcelain(root).filter((l) => l.startsWith(' D'))).toEqual([]);
  });

  it('writeHandoff end-to-end: tracked archives survive rotation, git status shows no M/D', async () => {
    seedArchives(root, ['2026-01-01-0100.md', '2026-01-02-0100.md']);
    commitArchives(root);

    const res = await writeHandoff('# rotate\n', {
      projectRoot: root,
      keep: 1,
      throttleMs: 0,
      now: () => new Date(2026, 5, 1, 9, 0, 0),
    });

    expect(res.pruned).toBe(0);
    expect(res.protectedTracked).toBe(2);
    expect(res.pruneSkipped).toBeNull();
    expect(porcelain(root)).toEqual(['?? .artibot/handoffs/2026-06-01-0900.md']);
    expect(checkHandoffTrackedIntegrity(root)).toEqual({ inRepo: true, modified: [], deleted: [], error: null });
  });

  it('git repo but ls-files fails → fail-closed: no reuse, no prune, pruneSkipped=git-unknown', async () => {
    seedArchives(root, ['2026-05-19-1200.md', '2026-05-19-1100.md', '2026-05-19-1000.md']);
    commitArchives(root);
    const calls = [];
    const exec = (file, args, opts) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return 'true\n';
      if (args[0] === 'ls-files') throw new Error('simulated: index locked');
      return git(opts.cwd, ...args);
    };

    const res = await writeHandoff('# unknown\n', {
      projectRoot: root,
      keep: 0,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 5, 0),
      exec,
    });

    expect(res.throttled).toBe(false);
    expect(res.pruned).toBe(0);
    expect(res.pruneSkipped).toBe('git-unknown');
    expect(res.protectedTracked).toBe(0);
    expect(calls).toContain('ls-files -z -- .artibot/handoffs');
    expect((await listHandoffs(root)).length).toBe(4);
    expect(porcelain(root)).toEqual(['?? .artibot/handoffs/2026-05-19-1205.md']);

    const prune = await pruneHandoffs(root, { keep: 0, exec });
    expect(prune).toEqual({ removed: 0, protectedTracked: 0, skipped: 'git-unknown' });
    expect((await listHandoffs(root)).length).toBe(4);
  });

  it('git binary unavailable but .git exists → treated as unknown (fail-closed)', async () => {
    seedArchives(root, ['2026-05-19-1200.md']);
    commitArchives(root);

    const res = await writeHandoff('# no git\n', {
      projectRoot: root,
      keep: 0,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 5, 0),
      exec: noGitExec,
    });
    expect(res.throttled).toBe(false);
    expect(res.pruned).toBe(0);
    expect(res.pruneSkipped).toBe('git-unknown');
    expect(porcelain(root)).toEqual(['?? .artibot/handoffs/2026-05-19-1205.md']);

    const integrity = checkHandoffTrackedIntegrity(root, { exec: noGitExec });
    expect(integrity).toEqual({ inRepo: true, modified: [], deleted: [], error: 'git unavailable' });
  });

  it('projectRoot BELOW the repo root with git unavailable → still fail-closed (ancestor .git counts)', async () => {
    // Review finding 2026-09-02: a sibling-only `.git` check turned "git
    // broken" into "not a repo" for any sub-directory project root, and the
    // legacy prune then unlinked tracked archives.
    const sub = path.join(root, 'sub');
    seedArchives(sub, ['2026-05-19-1200.md', '2026-05-19-1100.md', '2026-05-19-1000.md', '2026-05-19-0900.md']);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'track sub archives');

    const prune = await pruneHandoffs(sub, { keep: 1, exec: noGitExec });
    expect(prune).toEqual({ removed: 0, protectedTracked: 0, skipped: 'git-unknown' });
    expect((await listHandoffs(sub)).length).toBe(4);

    const res = await writeHandoff('# sub\n', {
      projectRoot: sub, keep: 1, throttleMs: 10 * 60_000, now: () => new Date(2026, 4, 19, 12, 5, 0), exec: noGitExec,
    });
    expect(res.throttled).toBe(false);
    expect(res.pruned).toBe(0);
    expect(res.pruneSkipped).toBe('git-unknown');
    // `porcelain()` is scoped to the root's own handoffs dir — look at `sub` directly.
    const subStatus = git(root, 'status', '--porcelain', '--', 'sub').split(/\r?\n/).filter(Boolean);
    expect(subStatus).toEqual(['?? sub/.artibot/HANDOFF.md', '?? sub/.artibot/handoffs/2026-05-19-1205.md']);
    expect((await listHandoffs(sub)).length).toBe(5);
  });

  it('non-git dir with git unavailable → legacy behaviour (reuse + prune, pruneSkipped=null)', async () => {
    const plain = makeTempRoot();
    try {
      const at = (m) => ({
        projectRoot: plain, throttleMs: 10 * 60_000, now: () => new Date(2026, 4, 19, 12, m, 0), exec: noGitExec,
      });
      const r1 = await writeHandoff('# a\n', at(0));
      const r2 = await writeHandoff('# b\n', at(5));
      expect(r2.throttled).toBe(true);
      expect(r2.archivePath).toBe(r1.archivePath);
      expect(r2.pruneSkipped).toBeNull();
      expect(r2.protectedTracked).toBe(0);
      expect(checkHandoffTrackedIntegrity(plain, { exec: noGitExec }))
        .toEqual({ inRepo: false, modified: [], deleted: [], error: null });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('checkHandoffTrackedIntegrity reports M and D for tracked archives', async () => {
    const [a, b] = seedArchives(root, ['2026-01-01-0100.md', '2026-01-02-0100.md', '2026-01-03-0100.md']);
    commitArchives(root);
    expect(checkHandoffTrackedIntegrity(root)).toEqual({ inRepo: true, modified: [], deleted: [], error: null });

    writeFileSync(a, '# clobbered\n', 'utf8');
    rmSync(b);
    seedArchives(root, ['2026-09-01-0100.md']); // untracked: must not be reported

    const out = checkHandoffTrackedIntegrity(root);
    expect(out.inRepo).toBe(true);
    expect(out.error).toBeNull();
    expect(out.modified).toEqual(['.artibot/handoffs/2026-01-01-0100.md']);
    expect(out.deleted).toEqual(['.artibot/handoffs/2026-01-02-0100.md']);
  });

  it('checkHandoffTrackedIntegrity never throws when git status fails', () => {
    const exec = (file, args) => {
      if (args[0] === 'rev-parse') return 'true\n';
      throw new Error('simulated status failure');
    };
    const out = checkHandoffTrackedIntegrity(root, { exec });
    expect(out).toEqual({ inRepo: true, modified: [], deleted: [], error: 'simulated status failure' });
  });
});

// ---------------------------------------------------------------------------
// Ordering: filename stamp beats mtime
// ---------------------------------------------------------------------------

describe('handoff-store / stamp ordering', () => {
  let root;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('newest is decided by filename stamp even when an older stamp has a newer mtime', async () => {
    const [jan, feb] = seedArchives(root, ['2026-01-01-0100.md', '2026-02-01-0100.md']);
    // Simulate a checkout: the January file gets the freshest mtime.
    utimesSync(feb, new Date(2026, 1, 1, 1, 0, 0), new Date(2026, 1, 1, 1, 0, 0));
    utimesSync(jan, new Date(2026, 8, 1, 0, 0, 0), new Date(2026, 8, 1, 0, 0, 0));

    const list = await listHandoffs(root);
    expect(list.map((r) => r.filename)).toEqual(['2026-02-01-0100.md', '2026-01-01-0100.md']);
    expect(list[0].stampMs).toBe(new Date(2026, 1, 1, 1, 0).getTime());
    expect(list[0].seq).toBe(1);
  });

  it('collision sequence orders -2 after the base name; foreign names fall back to mtime', async () => {
    const [base, two, foreign] = seedArchives(root, ['2026-03-01-0900.md', '2026-03-01-0900-2.md', 'HANDOFF-legacy.md']);
    const t = new Date(2026, 2, 1, 9, 0, 30);
    utimesSync(base, t, t);
    utimesSync(two, t, t);
    // Foreign file: mtime later than the March stamps → sorts first by mtime.
    const tf = new Date(2026, 2, 1, 9, 5, 0);
    utimesSync(foreign, tf, tf);

    const list = await listHandoffs(root);
    expect(list.map((r) => r.filename)).toEqual(['HANDOFF-legacy.md', '2026-03-01-0900-2.md', '2026-03-01-0900.md']);
    expect(list[0].stampMs).toBeNull();
    expect(list[1].seq).toBe(2);
  });

  it('throttle age is measured from the stamp, so a refreshed mtime cannot make an old archive reusable', async () => {
    const [old] = seedArchives(root, ['2026-01-01-0100.md']);
    const fresh = new Date(2026, 4, 19, 12, 4, 0);
    utimesSync(old, fresh, fresh);

    const res = await writeHandoff('# fresh\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 5, 0),
      exec: noGitExec,
    });
    expect(res.throttled).toBe(false);
    expect(readFileSync(old, 'utf8')).toBe('# 2026-01-01-0100.md\n');
  });

  it('foreign (non-stamped) newest file is never an in-place reuse target', async () => {
    const [foreign] = seedArchives(root, ['HANDOFF-legacy.md']);
    const t = new Date(2026, 4, 19, 12, 4, 0);
    utimesSync(foreign, t, t);
    const res = await writeHandoff('# x\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 5, 0),
      exec: noGitExec,
    });
    expect(res.throttled).toBe(false);
    expect(readFileSync(foreign, 'utf8')).toBe('# HANDOFF-legacy.md\n');
  });
});

describe('handoff-store / _internals parsers', () => {
  it('parseArchiveStamp accepts stamp and -n suffix, rejects foreign names', () => {
    expect(parseArchiveStamp('2026-05-19-1230.md')).toEqual({ stampMs: new Date(2026, 4, 19, 12, 30).getTime(), seq: 1 });
    expect(parseArchiveStamp('2026-05-19-1230-7.md')).toEqual({ stampMs: new Date(2026, 4, 19, 12, 30).getTime(), seq: 7 });
    expect(parseArchiveStamp('2026-05-19-1230-a1b2c3.md')).toBeNull();
    expect(parseArchiveStamp('HANDOFF-20260519-114433.md')).toBeNull();
    expect(parseArchiveStamp('2026-05-19-1230.txt')).toBeNull();
  });

  it('parsePorcelainZ handles M, D, rename pairs and untracked', () => {
    const out = [
      ' M .artibot/handoffs/a.md',
      ' D .artibot/handoffs/b.md',
      'R  .artibot/handoffs/c.md', '.artibot/handoffs/old-c.md',
      '?? .artibot/handoffs/d.md',
      'A  .artibot/handoffs/e.md',
      'MM .artibot/handoffs/f.md',
    ].join('\0') + '\0';
    // A rename of a tracked archive surfaces under `modified` (review finding
    // 2026-09-02: it used to be consumed and dropped, escaping the probe).
    expect(parsePorcelainZ(out)).toEqual({
      modified: [
        '.artibot/handoffs/a.md',
        '.artibot/handoffs/c.md (renamed from .artibot/handoffs/old-c.md)',
        '.artibot/handoffs/f.md',
      ],
      deleted: ['.artibot/handoffs/b.md'],
    });
    expect(parsePorcelainZ('')).toEqual({ modified: [], deleted: [] });
  });
});
