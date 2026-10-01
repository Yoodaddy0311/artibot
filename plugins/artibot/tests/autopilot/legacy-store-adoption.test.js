/**
 * `lib/autopilot/legacy-store-adoption.js` — the one-time copy of the store an
 * older build kept inside the plugin root into the store it lives in now (O2,
 * owner decision D2). Driven through `session-store.js` (`getStoreDir` is the
 * trigger, `migrateLegacyStore` the explicit entry), which is how every real
 * caller reaches it.
 *
 * WHAT IS PINNED, and why each one is a separate case rather than one round trip:
 *   - copy-if-absent: a session the store already has is never overwritten;
 *   - once per id: a session the user deleted does not come back from the legacy
 *     directory that still holds it — including when the NEXT plugin version
 *     hands over a snapshot of ids already migrated;
 *   - what is left behind on purpose: `worktrees/` and `locks/`;
 *   - non-destructive: the legacy directory is byte-identical afterwards;
 *   - hermetic sandboxes: an honoured `ARTIBOT_AUTOPILOT_STORE_DIR` switches the
 *     adoption off, so a test store can never be seeded with real sessions.
 *
 * Every seam that could move the store is removed in `beforeEach` and HOME is
 * repointed, so the DEFAULT resolution is what runs and the developer's own
 * `~/.claude` can neither be read nor written.
 *
 * WHAT THIS FILE CANNOT SEE (rules §9):
 *   - Two processes adopting at the same instant. The per-file publish is an
 *     exclusive create (measured in `core/file.js` to be race-free where an
 *     `existsSync` + rename was not), but no test here races real processes.
 *   - Fixture size. These sessions are a few hundred bytes; the live ones are
 *     3-7 KB and the owner's dev checkout holds 26 lock files and 4 memory files.
 *   - What the host does to the plugin cache. That a previous version directory
 *     is copied forward is inferred from identical mtimes (2026-09-30); the
 *     mechanism is not in this repository, and the adoption is written to be
 *     correct whether or not it happens.
 */

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../lib/autopilot/session-store.js';
import { readEvents } from '../../lib/autopilot/telemetry.js';

/** Every variable that could move the store; saved, cleared, restored per test. */
const ENV_KEYS = [
  'CLAUDE_PLUGIN_ROOT',
  'ARTIBOT_AUTOPILOT_STORE_DIR',
  'ARTIBOT_AUTOPILOT_STORE_DIR_ROOT',
  'ARTIBOT_STATE_DIR',
  'ARTIBOT_STATE_DIR_HOME',
  'USERPROFILE',
  'HOME',
];

/** @type {Record<string, string|undefined>} */
let savedEnv;
let tmp;
let home;
let rootA;
let rootB;

/** A plugin root shaped enough for `getPluginRoot` to treat it as real. */
function makePluginRoot(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'artibot.config.json'), '{}', 'utf-8');
  return dir;
}

/** Where the store must be, for the sandbox HOME. */
function expectedStore() {
  return path.join(home, '.claude', 'artibot', 'runtime', 'autopilot');
}

function useRoot(root) {
  process.env.CLAUDE_PLUGIN_ROOT = root;
}

/** The store a BUILD BEFORE D2 would have used under `root`. */
function legacyStore(root) {
  return path.join(root, 'runtime', 'autopilot');
}

function writeLegacySession(root, id, extra = {}) {
  const dir = legacyStore(root);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({ sessionId: id, phase: 'PAUSED', task: `task-${id}`, ...extra }), 'utf-8');
  return file;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-adopt-'));
  home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  rootA = makePluginRoot(path.join(tmp, 'cache', '4.70.0'));
  rootB = makePluginRoot(path.join(tmp, 'cache', '4.71.0'));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  useRoot(rootA);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('legacy store migration — copy once, copy-if-absent', () => {
  it('adopts the sessions of <pluginRoot>/runtime/autopilot on first use', () => {
    writeLegacySession(rootA, 'ap-legacy-1');
    writeLegacySession(rootA, 'ap-legacy-2');

    expect(store.listSessions().sort()).toEqual(['ap-legacy-1', 'ap-legacy-2']);
    expect(store.loadSession('ap-legacy-1')?.task).toBe('task-ap-legacy-1');
    expect(existsSync(path.join(expectedStore(), 'ap-legacy-2.json'))).toBe(true);
  });

  it('copies a session together with its events and schema backups, and the feature memory', () => {
    const legacy = legacyStore(rootA);
    writeLegacySession(rootA, 'ap-with-sidecars');
    writeFileSync(path.join(legacy, 'ap-with-sidecars.events.ndjson'), '{"type":"old"}\n', 'utf-8');
    writeFileSync(path.join(legacy, 'ap-with-sidecars.json.v2.bak'), '{"v":2}', 'utf-8');
    mkdirSync(path.join(legacy, 'memory'), { recursive: true });
    writeFileSync(path.join(legacy, 'memory', 'some-feature.jsonl'), '{"lesson":"kept"}\n', 'utf-8');

    const report = store.migrateLegacyStore();

    expect(report.sessions).toEqual(['ap-with-sidecars']);
    expect(report.memory).toEqual(['some-feature.jsonl']);
    const dest = expectedStore();
    expect(readFileSync(path.join(dest, 'ap-with-sidecars.events.ndjson'), 'utf-8')).toBe('{"type":"old"}\n');
    expect(readFileSync(path.join(dest, 'ap-with-sidecars.json.v2.bak'), 'utf-8')).toBe('{"v":2}');
    expect(readFileSync(path.join(dest, 'memory', 'some-feature.jsonl'), 'utf-8')).toBe('{"lesson":"kept"}\n');
    expect(readEvents('ap-with-sidecars').map((e) => e.type)).toEqual(['old']);
  });

  it('leaves the legacy directory exactly as it found it (non-destructive)', () => {
    const file = writeLegacySession(rootA, 'ap-untouched');
    const before = { bytes: readFileSync(file, 'utf-8'), mtimeMs: statSync(file).mtimeMs, names: readdirSync(legacyStore(rootA)) };

    store.migrateLegacyStore();

    expect(readFileSync(file, 'utf-8')).toBe(before.bytes);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(legacyStore(rootA))).toEqual(before.names);
  });

  it('keeps the legacy mtime, so "most recently modified" still orders sessions', () => {
    const file = writeLegacySession(rootA, 'ap-old-mtime');
    const old = new Date('2026-09-01T00:00:00Z');
    utimesSync(file, old, old);

    store.migrateLegacyStore();

    expect(statSync(path.join(expectedStore(), 'ap-old-mtime.json')).mtimeMs).toBe(old.getTime());
  });

  it('keeps a legacy mtime finer than a millisecond (NTFS stamps are; a Date argument would truncate)', () => {
    const file = writeLegacySession(rootA, 'ap-fine-mtime');
    // .5 ms of fraction: a copy made through `Date` objects loses exactly that.
    utimesSync(file, 1788000000.1235, 1788000000.1235);
    const sourceMs = statSync(file).mtimeMs;

    store.migrateLegacyStore();

    const copiedMs = statSync(path.join(expectedStore(), 'ap-fine-mtime.json')).mtimeMs;
    expect(Math.abs(copiedMs - sourceMs)).toBeLessThan(0.05);
  });

  it('does NOT copy worktrees or locks: a git worktree cannot be copied, locks are judged by the lock rules', () => {
    const legacy = legacyStore(rootA);
    writeLegacySession(rootA, 'ap-no-extras');
    mkdirSync(path.join(legacy, 'worktrees', 'ap-no-extras'), { recursive: true });
    writeFileSync(path.join(legacy, 'worktrees', 'ap-no-extras', '.git'), 'gitdir: elsewhere', 'utf-8');
    mkdirSync(path.join(legacy, 'locks'), { recursive: true });
    writeFileSync(path.join(legacy, 'locks', 'dead.lock'), JSON.stringify({ pid: 99999999, sessionId: 'x', acquiredAt: Date.now() }), 'utf-8');

    store.migrateLegacyStore();

    expect(existsSync(path.join(expectedStore(), 'worktrees'))).toBe(false);
    expect(existsSync(path.join(expectedStore(), 'locks', 'dead.lock'))).toBe(false);
  });

  it('never overwrites a session the store already has (copy-if-absent)', () => {
    writeLegacySession(rootA, 'ap-both', { task: 'legacy copy' });
    // Written straight to disk BEFORE the store is first touched: going through
    // saveSession would itself trigger the adoption and make the legacy copy the
    // one being overwritten, which is the opposite of what is asserted.
    mkdirSync(expectedStore(), { recursive: true });
    const native = path.join(expectedStore(), 'ap-both.json');
    writeFileSync(native, JSON.stringify({ sessionId: 'ap-both', task: 'native copy' }), 'utf-8');
    const nativeBytes = readFileSync(native, 'utf-8');

    const report = store.migrateLegacyStore();

    expect(readFileSync(native, 'utf-8')).toBe(nativeBytes);
    expect(report.sessions).toEqual([]);
    expect(report.present).toEqual(['ap-both']);
    // ...and a session the store owns keeps its side files to itself.
    writeFileSync(path.join(legacyStore(rootA), 'ap-both.events.ndjson'), '{"type":"legacy"}\n', 'utf-8');
    store.migrateLegacyStore({ force: true });
    expect(existsSync(path.join(expectedStore(), 'ap-both.events.ndjson'))).toBe(false);
  });

  it('is idempotent: a second pass copies nothing and changes nothing', () => {
    writeLegacySession(rootA, 'ap-once');
    expect(store.migrateLegacyStore().sessions).toEqual(['ap-once']);
    const dest = path.join(expectedStore(), 'ap-once.json');
    const first = { bytes: readFileSync(dest, 'utf-8'), mtimeMs: statSync(dest).mtimeMs };

    expect(store.migrateLegacyStore({ force: true }).sessions).toEqual([]);
    expect(readFileSync(dest, 'utf-8')).toBe(first.bytes);
    expect(statSync(dest).mtimeMs).toBe(first.mtimeMs);
  });

  it('does not bring a deleted session back (once means once)', () => {
    writeLegacySession(rootA, 'ap-deleted');
    store.migrateLegacyStore();
    expect(store.deleteSessionArtifacts('ap-deleted').session).toBe(true);

    // A later process on the same legacy directory, which still holds the file.
    const again = store.migrateLegacyStore({ force: true });
    expect(again.sessions).toEqual([]);
    expect(store.listSessions()).not.toContain('ap-deleted');
  });

  it('does not bring a deleted session back from ANOTHER version that carries the same id', () => {
    // The host copies the previous version directory forward, so the next
    // version's legacy store holds a snapshot of ids already migrated.
    writeLegacySession(rootA, 'ap-carried');
    store.migrateLegacyStore();
    store.deleteSessionArtifacts('ap-carried');

    writeLegacySession(rootB, 'ap-carried');
    writeLegacySession(rootB, 'ap-fresh-in-b');
    useRoot(rootB);
    const report = store.migrateLegacyStore();

    expect(report.sessions).toEqual(['ap-fresh-in-b']);
    expect(store.listSessions()).not.toContain('ap-carried');
  });

  it('adopts a session that appears in the legacy store AFTER the first pass', () => {
    writeLegacySession(rootA, 'ap-first');
    store.migrateLegacyStore();
    writeLegacySession(rootA, 'ap-late');

    expect(store.migrateLegacyStore({ force: true }).sessions).toEqual(['ap-late']);
    expect(store.listSessions().sort()).toEqual(['ap-first', 'ap-late']);
  });

  it('runs on its own the first time the store is touched, once per process', () => {
    writeLegacySession(rootA, 'ap-implicit');
    expect(existsSync(expectedStore())).toBe(false);

    // getStoreDir() is what every reader and writer goes through, so the first
    // call is the trigger — a caller never has to remember to migrate.
    store.getStoreDir();
    expect(existsSync(path.join(expectedStore(), 'ap-implicit.json'))).toBe(true);

    // Not re-run per call: a legacy file added now waits for the next process.
    writeLegacySession(rootA, 'ap-after-first-call');
    store.getStoreDir();
    expect(existsSync(path.join(expectedStore(), 'ap-after-first-call.json'))).toBe(false);
  });

  it('is NOT triggered by resolveStoreDir(), the pure resolver a dry-run tool uses', () => {
    writeLegacySession(rootA, 'ap-not-by-peeking');

    expect(store.resolveStoreDir()).toBe(expectedStore());
    expect(existsSync(expectedStore())).toBe(false);
    // ...and it names exactly the directory getStoreDir() does.
    expect(store.getStoreDir()).toBe(store.resolveStoreDir());
  });

  it('is skipped while an honoured ARTIBOT_AUTOPILOT_STORE_DIR redirects the store', () => {
    writeLegacySession(rootA, 'ap-real-one');
    const sandbox = path.join(tmp, 'sandbox-store');
    process.env.ARTIBOT_AUTOPILOT_STORE_DIR = sandbox;
    process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT = rootA;

    const report = store.migrateLegacyStore({ force: true });
    store.getStoreDir();

    expect(report.skipped).toBe('override');
    // A sandbox is hermetic: real sessions must never appear in it.
    expect(existsSync(sandbox)).toBe(false);
    expect(store.getLegacyStoreDirs()).toEqual([]);
  });

  it('reports why it did nothing when there is nothing to adopt', () => {
    expect(store.migrateLegacyStore({ force: true }).skipped).toBe('no-legacy');
    mkdirSync(legacyStore(rootA), { recursive: true });
    expect(store.migrateLegacyStore({ force: true }).skipped).toBe('nothing-to-adopt');
  });

  it('ignores a directory that merely has a session-looking name', () => {
    writeLegacySession(rootA, 'ap-good');
    mkdirSync(path.join(legacyStore(rootA), 'ap-dir-not-file.json'), { recursive: true });

    const report = store.migrateLegacyStore({ force: true });

    expect(report.sessions).toEqual(['ap-good']);
    expect(report.errors).toBe(0);
  });

  it('never throws, and still copies, when a marker cannot be written', () => {
    writeLegacySession(rootA, 'ap-ledger-blocked');
    // The ledger is a DIRECTORY of markers; a plain FILE squatting on its path
    // makes every marker write fail on every platform.
    mkdirSync(expectedStore(), { recursive: true });
    writeFileSync(path.join(expectedStore(), 'legacy-migration.ledger'), 'in the way', 'utf-8');

    let report;
    expect(() => { report = store.migrateLegacyStore({ force: true }); }).not.toThrow();

    expect(report.sessions).toEqual(['ap-ledger-blocked']);
    expect(report.errors).toBeGreaterThanOrEqual(1);
    expect(store.loadSession('ap-ledger-blocked')?.task).toBe('task-ap-ledger-blocked');
  });

  it('keeps one marker file per adopted id, each created exclusively (no shared ledger to lose)', () => {
    writeLegacySession(rootA, 'ap-marked-1');
    writeLegacySession(rootA, 'ap-marked-2');
    mkdirSync(path.join(legacyStore(rootA), 'memory'), { recursive: true });
    writeFileSync(path.join(legacyStore(rootA), 'memory', 'feat.jsonl'), '{"lesson":"x"}\n', 'utf-8');

    store.migrateLegacyStore();

    const markers = readdirSync(path.join(expectedStore(), 'legacy-migration.ledger')).sort();
    expect(markers).toEqual(['memory.feat.jsonl', 'session.ap-marked-1', 'session.ap-marked-2']);
    // A second pass finds every marker and writes none: the directory is unchanged.
    const before = markers.map((name) => statSync(path.join(expectedStore(), 'legacy-migration.ledger', name)).mtimeMs);
    store.migrateLegacyStore({ force: true });
    const after = markers.map((name) => statSync(path.join(expectedStore(), 'legacy-migration.ledger', name)).mtimeMs);
    expect(after).toEqual(before);
  });

  it('never makes the migration ledger look like a session', () => {
    writeLegacySession(rootA, 'ap-ledgered');
    store.migrateLegacyStore();

    const names = readdirSync(expectedStore());
    expect(names.some((n) => n.includes('ledger'))).toBe(true);
    // listSessions / the census / the pruner all key on the `.json` suffix.
    expect(store.listSessions()).toEqual(['ap-ledgered']);
  });
});

describe('every place an older build left sessions (review of 6b410964, SHOULD 2)', () => {
  // The first version adopted only what sat under the plugin root IN FORCE, so a
  // session that existed only in an older version directory — or in the
  // marketplace mirror the host copies from — was never adopted. The sources are
  // now the running root, every cached version (newest first) and the mirror.
  const cacheDir = (version) => path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot', version);
  const cloneDir = () => path.join(home, '.claude', 'plugins', 'marketplaces', 'artibot');
  const mirrorRoot = () => path.join(cloneDir(), 'plugins', 'artibot');

  /** A version directory shaped like the host's cache entry, holding `ids` as legacy sessions. */
  function versionDir(version, ids = []) {
    const root = makePluginRoot(cacheDir(version));
    for (const id of ids) writeLegacySession(root, id, { from: version });
    return root;
  }

  /** The marketplace mirror: a git clone (so it has a `.git`) with the `plugins/artibot` layout. */
  function mirror(ids = []) {
    mkdirSync(path.join(cloneDir(), '.git'), { recursive: true });
    const root = makePluginRoot(mirrorRoot());
    for (const id of ids) writeLegacySession(root, id, { from: 'mirror' });
    return root;
  }

  /** A developer checkout: `<repo>/plugins/artibot` with `<repo>/.git`. */
  function devCheckout(name, { gitIsAFile = false } = {}) {
    const repo = path.join(tmp, name);
    mkdirSync(repo, { recursive: true });
    if (gitIsAFile) writeFileSync(path.join(repo, '.git'), 'gitdir: /elsewhere/.git/worktrees/x', 'utf-8');
    else mkdirSync(path.join(repo, '.git'), { recursive: true });
    return makePluginRoot(path.join(repo, 'plugins', 'artibot'));
  }

  it('adopts a session that exists only in an OLDER version directory', () => {
    const running = versionDir('4.71.0');
    versionDir('4.68.0', ['ap-only-in-4-68']);
    useRoot(running);

    expect(store.listSessions()).toEqual(['ap-only-in-4-68']);
    expect(store.loadSession('ap-only-in-4-68')?.from).toBe('4.68.0');
  });

  it('adopts from every cached version, not only the one that is running', () => {
    versionDir('4.71.0', ['ap-in-running']);
    versionDir('4.70.0', ['ap-in-470']);
    versionDir('4.69.0', ['ap-in-469']);
    useRoot(cacheDir('4.71.0'));

    const report = store.migrateLegacyStore();

    expect(report.sessions.sort()).toEqual(['ap-in-469', 'ap-in-470', 'ap-in-running']);
  });

  it('adopts from the marketplace mirror, which is a git clone but NOT a developer checkout', () => {
    // The mirror has a `.git` and the `plugins/artibot` layout — exactly what a
    // developer checkout looks like — yet it is where real sessions were measured
    // (2026-09-30: all four of the owner's, with their `lockPath` pointing there).
    mirror(['ap-in-mirror']);
    useRoot(versionDir('4.71.0'));

    expect(store.migrateLegacyStore().sessions).toEqual(['ap-in-mirror']);
  });

  it('adopts the mirror when IT is the running root', () => {
    useRoot(mirror(['ap-running-from-mirror']));

    expect(store.migrateLegacyStore().sessions).toEqual(['ap-running-from-mirror']);
  });

  it('prefers the FRESHEST copy when several directories hold the same session', () => {
    // A running older build keeps writing in its own directory after the host
    // copied a snapshot forward, so the older directory can hold the newer state.
    const newer = versionDir('4.70.0');
    const older = versionDir('4.69.0');
    const stale = writeLegacySession(newer, 'ap-dup', { from: '4.70.0-stale-snapshot' });
    const fresh = writeLegacySession(older, 'ap-dup', { from: '4.69.0-still-running' });
    utimesSync(stale, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    utimesSync(fresh, new Date('2026-09-20T00:00:00Z'), new Date('2026-09-20T00:00:00Z'));
    useRoot(versionDir('4.71.0'));

    store.migrateLegacyStore();

    expect(store.loadSession('ap-dup')?.from).toBe('4.69.0-still-running');
  });

  it('takes the newer DIRECTORY on a tie, and never adopts one id twice', () => {
    const t = new Date('2026-09-10T00:00:00Z');
    const a = writeLegacySession(versionDir('4.70.0'), 'ap-tie', { from: '4.70.0' });
    const b = writeLegacySession(versionDir('4.69.0'), 'ap-tie', { from: '4.69.0' });
    utimesSync(a, t, t);
    utimesSync(b, t, t);
    useRoot(versionDir('4.71.0'));

    const report = store.migrateLegacyStore();

    expect(store.loadSession('ap-tie')?.from).toBe('4.70.0');
    expect(report.sessions).toEqual(['ap-tie']);
  });

  it('does NOT adopt from a developer checkout: it holds sessions the test suite wrote', () => {
    const dev = devCheckout('dev-repo');
    writeLegacySession(dev, 'ap-test-origin');
    useRoot(dev);

    expect(store.getLegacyStoreDirs()).not.toContain(legacyStore(dev));
    expect(store.migrateLegacyStore().sessions).toEqual([]);
    expect(store.listSessions()).toEqual([]);
  });

  it('treats a LINKED worktree (its `.git` is a file) as a developer checkout too', () => {
    const dev = devCheckout('dev-worktree', { gitIsAFile: true });
    writeLegacySession(dev, 'ap-test-origin-wt');
    useRoot(dev);

    expect(store.migrateLegacyStore().sessions).toEqual([]);
  });

  it('skips only the developer checkout itself — installed versions are still adopted from it', () => {
    versionDir('4.70.0', ['ap-installed']);
    const dev = devCheckout('dev-repo-2');
    writeLegacySession(dev, 'ap-test-origin-2');
    useRoot(dev);

    expect(store.migrateLegacyStore().sessions).toEqual(['ap-installed']);
  });

  it('does not mistake a plugin root that merely sits under a repository for a checkout', () => {
    // `<repo>/plugins/artibot` is a developer checkout only while `<repo>/.git` exists.
    const repo = path.join(tmp, 'just-a-folder');
    const root = makePluginRoot(path.join(repo, 'plugins', 'artibot'));
    writeLegacySession(root, 'ap-not-a-checkout');
    useRoot(root);

    expect(store.migrateLegacyStore().sessions).toEqual(['ap-not-a-checkout']);
  });

  it('does not scan the installed versions while ARTIBOT_STATE_DIR redirects the state dir', () => {
    // A redirected state dir is a sandbox (the test suite sets one for every
    // worker): the user's real installed versions are not its business.
    versionDir('4.70.0', ['ap-installed-not-mine']);
    const running = versionDir('4.71.0', ['ap-in-running-root']);
    useRoot(running);
    process.env.ARTIBOT_STATE_DIR = path.join(tmp, 'sandbox-state');
    process.env.ARTIBOT_STATE_DIR_HOME = home;

    expect(store.migrateLegacyStore().sessions).toEqual(['ap-in-running-root']);
  });

  it('lists the sources in precedence order: running root, versions newest first, mirror', () => {
    // 4.10.0 is NEWER than 4.9.0; a string sort gets that backwards.
    const running = versionDir('4.70.0', ['ap-r']);
    versionDir('4.9.0', ['ap-1']);
    versionDir('4.10.0', ['ap-2']);
    versionDir('4.71.0', ['ap-3']);
    mkdirSync(path.join(cacheDir('latest'), 'runtime', 'autopilot'), { recursive: true });
    writeFileSync(path.join(path.dirname(cacheDir('4.70.0')), 'README.txt'), 'not a directory', 'utf-8');
    mirror(['ap-m']);
    useRoot(running);

    expect(store.getLegacyStoreDirs().map((d) => path.relative(home, d))).toEqual([
      path.join('.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.70.0', 'runtime', 'autopilot'),
      path.join('.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.71.0', 'runtime', 'autopilot'),
      path.join('.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.10.0', 'runtime', 'autopilot'),
      path.join('.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.9.0', 'runtime', 'autopilot'),
      path.join('.claude', 'plugins', 'cache', 'artibot', 'artibot', 'latest', 'runtime', 'autopilot'),
      path.join('.claude', 'plugins', 'marketplaces', 'artibot', 'plugins', 'artibot', 'runtime', 'autopilot'),
    ]);
  });

  it('lists only directories that exist, and never the store itself', () => {
    const running = versionDir('4.71.0');
    mkdirSync(cacheDir('4.70.0'), { recursive: true }); // a version with no runtime/autopilot at all
    useRoot(running);

    expect(store.getLegacyStoreDirs()).toEqual([]);
    expect(store.migrateLegacyStore().skipped).toBe('no-legacy');
  });
});
