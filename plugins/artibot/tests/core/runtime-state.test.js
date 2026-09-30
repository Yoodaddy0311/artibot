/**
 * Tests for lib/core/runtime-state.js — where GLOBAL and SESSION hook state
 * lives, how it is migrated out of the versioned plugin root, and how old
 * session directories are swept.
 *
 * Why this module exists (O2, measured 2026-09-30 on the owner's machine):
 * hooks wrote `current-effort.json`, `token-usage-session.json`,
 * `user-profile.json`, `first-run-state.json`, … into `<pluginRoot>/runtime/`.
 * In a marketplace install the plugin root is a version-scoped cache directory
 * (`~/.claude/plugins/cache/artibot/artibot/<v>/`), so every update orphaned the
 * state (cache dirs 4.67.0–4.70.0 each held their own `runtime/`), and two
 * concurrent sessions overwrote one flat file.
 *
 * WHAT THESE TESTS CANNOT SEE: they drive the module against a tmp HOME and the
 * `ARTIBOT_STATE_DIR` seam. They do not prove that every production writer goes
 * through it — `tests/firewall/runtime-state-survives-update.test.js` covers the
 * wired writers — and they say nothing about a real Claude Code session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveArtibotDir } from '../../lib/core/config.js';
import {
  migrateLegacyFile,
  resolveGlobalStateFile,
  resolveGlobalStatePath,
  resolveRuntimeDir,
  resolveScopedStatePath,
  resolveSessionDir,
  resolveSessionReadChain,
  resolveSessionStatePath,
  sanitizeSessionId,
  SESSION_DIR_KEEP,
  SESSION_DIR_MAX_AGE_MS,
  sweepSessionDirs,
} from '../../lib/core/runtime-state.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const DAY = 24 * 60 * 60 * 1000;

let base;
let stateDir;
let restoreState;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-runtime-state-'));
  stateDir = path.join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  restoreState = pointStateDirAt(stateDir);
});

afterEach(() => {
  restoreState();
  rmSync(base, { recursive: true, force: true });
});

function writeFile(filePath, content, mtimeMs) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    utimesSync(filePath, t, t);
  }
}

describe('locations', () => {
  it('runtime dir is <state dir>/runtime — the ARTIBOT_STATE_DIR seam moves it', () => {
    expect(resolveArtibotDir()).toBe(stateDir);
    expect(resolveRuntimeDir()).toBe(path.join(stateDir, 'runtime'));
  });

  it('with no override the state dir is ~/.claude/artibot, NOT the plugin root (marketplace layout)', () => {
    restoreState();
    const home = path.join(base, 'home');
    mkdirSync(home, { recursive: true });
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      ARTIBOT_STATE_DIR: process.env.ARTIBOT_STATE_DIR,
      ARTIBOT_STATE_DIR_HOME: process.env.ARTIBOT_STATE_DIR_HOME,
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    };
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      delete process.env.ARTIBOT_STATE_DIR;
      delete process.env.ARTIBOT_STATE_DIR_HOME;
      // A version-scoped cache dir, exactly what Claude Code hands a marketplace plugin.
      process.env.CLAUDE_PLUGIN_ROOT = path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.70.0');

      expect(resolveRuntimeDir()).toBe(path.join(home, '.claude', 'artibot', 'runtime'));
      expect(resolveRuntimeDir().startsWith(process.env.CLAUDE_PLUGIN_ROOT)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('under the install.sh layout the state dir IS the plugin root, so runtime/ is where it always was', () => {
    // install.sh puts the plugin at ~/.claude/artibot, and resolveArtibotDir() is ~/.claude/artibot.
    const installRoot = path.join(base, 'home', '.claude', 'artibot');
    restoreState();
    restoreState = pointStateDirAt(installRoot);
    expect(resolveRuntimeDir()).toBe(path.join(installRoot, 'runtime'));
    // and a legacy lookup in that root resolves to the very same file: nothing to copy.
    writeFile(path.join(installRoot, 'runtime', 'first-run-state.json'), '{"globalRuns":2}');
    const r = migrateLegacyFile(
      path.join(installRoot, 'runtime', 'first-run-state.json'),
      'runtime/first-run-state.json',
      { pluginRoot: installRoot },
    );
    expect(r.migrated).toBe(false);
    expect(readFileSync(path.join(installRoot, 'runtime', 'first-run-state.json'), 'utf8')).toBe('{"globalRuns":2}');
  });

  it('session state lives under runtime/sessions/<session_id>/', () => {
    expect(resolveSessionDir('abc-123')).toBe(path.join(stateDir, 'runtime', 'sessions', 'abc-123'));
    expect(resolveSessionStatePath('abc-123', 'current-effort.json'))
      .toBe(path.join(stateDir, 'runtime', 'sessions', 'abc-123', 'current-effort.json'));
  });

  it('resolveScopedStatePath: session file when the session is known, the flat file otherwise', () => {
    expect(resolveScopedStatePath('s1', 'token-usage-session.json'))
      .toBe(path.join(stateDir, 'runtime', 'sessions', 's1', 'token-usage-session.json'));
    for (const none of [undefined, null, '', '   ', 42, {}]) {
      expect(resolveScopedStatePath(none, 'token-usage-session.json'))
        .toBe(path.join(stateDir, 'runtime', 'token-usage-session.json'));
    }
  });

  it('refuses a file name that could leave the directory', () => {
    expect(() => resolveScopedStatePath('s1', '../x.json')).toThrow(TypeError);
    expect(() => resolveScopedStatePath('s1', 'a/b.json')).toThrow(TypeError);
    expect(() => resolveSessionStatePath('s1', '')).toThrow(TypeError);
  });

  it('resolveSessionReadChain: session → state-dir flat → plugin-root flat (legacy)', () => {
    const pluginRoot = path.join(base, 'plugin');
    expect(resolveSessionReadChain('s1', 'current-teammates.json', { pluginRoot })).toEqual([
      path.join(stateDir, 'runtime', 'sessions', 's1', 'current-teammates.json'),
      path.join(stateDir, 'runtime', 'current-teammates.json'),
      path.join(pluginRoot, 'runtime', 'current-teammates.json'),
    ]);
    // no session id → no session candidate; install layout → the legacy entry is the flat one, listed once.
    expect(resolveSessionReadChain(null, 'current-teammates.json', { pluginRoot: stateDir })).toEqual([
      path.join(stateDir, 'runtime', 'current-teammates.json'),
    ]);
  });
});

describe('sanitizeSessionId', () => {
  it('leaves a UUID untouched', () => {
    const uuid = '9120048e-3385-4855-a35b-09c89e5dd684';
    expect(sanitizeSessionId(uuid)).toBe(uuid);
  });

  it.each([
    ['../../etc/passwd', 'etc-passwd'],
    ['a b/c\\d', 'a-b-c-d'],
    ['..hidden', 'hidden'],
    ['-lead-dash', 'lead-dash'],
    ['x..y...z', 'x.y.z'],
    ['sess:1|2', 'sess-1-2'],
  ])('%s → %s', (raw, expected) => {
    expect(sanitizeSessionId(raw)).toBe(expected);
  });

  it('never yields a separator or a dot-dot, whatever it is given', () => {
    for (const raw of ['../..', '..\\..', 'a/../b', '/', '\\', '....']) {
      const out = sanitizeSessionId(raw);
      expect(out).not.toMatch(/[\\/]/);
      expect(out).not.toContain('..');
    }
  });

  it('answers empty for anything that is not a usable string', () => {
    for (const raw of [undefined, null, 42, {}, [], '', '   ', '...', '---', '.-.-']) {
      expect(sanitizeSessionId(raw)).toBe('');
    }
    expect(resolveSessionDir('...')).toBeNull();
    expect(resolveSessionStatePath(undefined, 'x.json')).toBeNull();
  });

  it('caps the length at 120', () => {
    expect(sanitizeSessionId('a'.repeat(300))).toHaveLength(120);
  });
});

describe('migrateLegacyFile — copy-if-absent', () => {
  const REL = 'runtime/first-run-state.json';

  it('copies <pluginRoot>/runtime/<file> to the new location when the new one is absent', () => {
    const pluginRoot = path.join(base, 'plugin');
    writeFile(path.join(pluginRoot, REL), '{"globalRuns":3}\n');
    const dest = resolveGlobalStatePath(REL);

    const r = migrateLegacyFile(dest, REL, { pluginRoot });

    expect(r).toMatchObject({ migrated: true, from: path.join(pluginRoot, REL) });
    expect(readFileSync(dest, 'utf8')).toBe('{"globalRuns":3}\n');
    // a COPY: the legacy file is not removed (an older version may still be running on it).
    expect(existsSync(path.join(pluginRoot, REL))).toBe(true);
  });

  it('never overwrites a file that is already at the new location', () => {
    const pluginRoot = path.join(base, 'plugin');
    writeFile(path.join(pluginRoot, REL), '{"globalRuns":1}\n');
    const dest = resolveGlobalStatePath(REL);
    writeFile(dest, '{"globalRuns":9}\n');

    const r = migrateLegacyFile(dest, REL, { pluginRoot });

    expect(r.migrated).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('{"globalRuns":9}\n');
  });

  it('is idempotent: the second call finds the file present and copies nothing', () => {
    const pluginRoot = path.join(base, 'plugin');
    writeFile(path.join(pluginRoot, REL), 'A');
    const dest = resolveGlobalStatePath(REL);

    expect(migrateLegacyFile(dest, REL, { pluginRoot }).migrated).toBe(true);
    writeFile(path.join(pluginRoot, REL), 'B');
    expect(migrateLegacyFile(dest, REL, { pluginRoot }).migrated).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('A');
  });

  it('creates nothing when there is no legacy file anywhere', () => {
    const pluginRoot = path.join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    const dest = resolveGlobalStatePath(REL);

    const r = migrateLegacyFile(dest, REL, { pluginRoot });

    expect(r).toMatchObject({ migrated: false, reason: 'no-legacy' });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(path.dirname(dest))).toBe(false);
  });

  it('never throws, even when the legacy "file" is a directory', () => {
    const pluginRoot = path.join(base, 'plugin');
    mkdirSync(path.join(pluginRoot, REL), { recursive: true });
    const dest = resolveGlobalStatePath(REL);
    expect(() => migrateLegacyFile(dest, REL, { pluginRoot })).not.toThrow();
    expect(existsSync(dest)).toBe(false);
  });

  describe('marketplace layout — the previous version sits NEXT TO the running one', () => {
    function versionRoot(version) {
      const root = path.join(base, 'cache', 'artibot', 'artibot', version);
      mkdirSync(root, { recursive: true });
      return root;
    }

    it('recovers the state the previous version wrote (newest file wins)', () => {
      const v69 = versionRoot('4.69.0');
      const v70 = versionRoot('4.70.0');
      const v71 = versionRoot('4.71.0');
      const now = Date.now();
      writeFile(path.join(v69, REL), 'from-4.69.0', now - 3 * DAY);
      writeFile(path.join(v70, REL), 'from-4.70.0', now - DAY);
      const dest = resolveGlobalStatePath(REL);

      const r = migrateLegacyFile(dest, REL, { pluginRoot: v71 });

      expect(r.migrated).toBe(true);
      expect(r.from).toBe(path.join(v70, REL));
      expect(readFileSync(dest, 'utf8')).toBe('from-4.70.0');
    });

    it('prefers the running version\'s own legacy file over a sibling\'s', () => {
      const v70 = versionRoot('4.70.0');
      const v71 = versionRoot('4.71.0');
      writeFile(path.join(v70, REL), 'from-4.70.0', Date.now());
      writeFile(path.join(v71, REL), 'from-4.71.0', Date.now() - 5 * DAY);
      const dest = resolveGlobalStatePath(REL);

      migrateLegacyFile(dest, REL, { pluginRoot: v71 });

      expect(readFileSync(dest, 'utf8')).toBe('from-4.71.0');
    });

    it('ignores siblings that are not version directories', () => {
      const v71 = versionRoot('4.71.0');
      writeFile(path.join(path.dirname(v71), 'scratch-copy', REL), 'not-a-version');
      writeFile(path.join(path.dirname(v71), 'runtime-backup', REL), 'not-a-version');
      const dest = resolveGlobalStatePath(REL);

      expect(migrateLegacyFile(dest, REL, { pluginRoot: v71 }).migrated).toBe(false);
      expect(existsSync(dest)).toBe(false);
    });

    it('scans nothing when the plugin root is not itself a version directory (dev checkout)', () => {
      const dev = path.join(base, 'repo', 'plugins', 'artibot');
      mkdirSync(dev, { recursive: true });
      writeFile(path.join(base, 'repo', 'plugins', '4.70.0', REL), 'sibling-of-a-checkout');
      const dest = resolveGlobalStatePath(REL);

      expect(migrateLegacyFile(dest, REL, { pluginRoot: dev }).migrated).toBe(false);
      expect(existsSync(dest)).toBe(false);
    });
  });

  it('tries extraSources after the plugin-root candidates', () => {
    const pluginRoot = path.join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    const old = path.join(stateDir, 'user-profile.json');
    writeFile(old, '{"skillLevel":"pro"}');
    const dest = resolveGlobalStatePath('runtime/user-profile.json');

    const r = migrateLegacyFile(dest, 'runtime/user-profile.json', { pluginRoot, extraSources: [old] });

    expect(r).toMatchObject({ migrated: true, from: old });
    expect(readFileSync(dest, 'utf8')).toBe('{"skillLevel":"pro"}');
  });
});

describe('resolveGlobalStateFile', () => {
  it('relative config paths resolve under the STATE dir, not the plugin root', () => {
    const pluginRoot = path.join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    expect(resolveGlobalStateFile('runtime/macro-suggestions.json', { pluginRoot }))
      .toBe(path.join(stateDir, 'runtime', 'macro-suggestions.json'));
    expect(resolveGlobalStatePath('runtime/macro-suggestions.json'))
      .toBe(path.join(stateDir, 'runtime', 'macro-suggestions.json'));
  });

  it('migrates the legacy file while resolving', () => {
    const pluginRoot = path.join(base, 'plugin');
    writeFile(path.join(pluginRoot, 'runtime', 'macro-suggestions.json'), '{"suggestions":[]}');

    const file = resolveGlobalStateFile('runtime/macro-suggestions.json', { pluginRoot });

    expect(readFileSync(file, 'utf8')).toBe('{"suggestions":[]}');
  });

  it('an absolute path is the operator\'s explicit choice — returned as is, never migrated', () => {
    const pluginRoot = path.join(base, 'plugin');
    const abs = path.join(base, 'elsewhere', 'first-run-state.json');
    writeFile(path.join(pluginRoot, 'runtime', 'first-run-state.json'), 'legacy');

    expect(resolveGlobalStateFile(abs, { pluginRoot })).toBe(abs);
    expect(existsSync(abs)).toBe(false);
  });
});

describe('sweepSessionDirs — session dirs cannot grow without bound', () => {
  const now = Date.parse('2026-09-30T00:00:00.000Z');

  function sessionDir(sid, files, mtimeMs) {
    const dir = path.join(stateDir, 'runtime', 'sessions', sid);
    for (const [name, content] of Object.entries(files)) writeFile(path.join(dir, name), content, mtimeMs);
    const t = new Date(mtimeMs);
    utimesSync(dir, t, t);
    return dir;
  }

  it('removes a session dir whose newest file is older than the cutoff and keeps a fresh one', () => {
    const stale = sessionDir('stale', { 'current-effort.json': '{}' }, now - 8 * DAY);
    const fresh = sessionDir('fresh', { 'current-effort.json': '{}' }, now - 1 * DAY);

    const r = sweepSessionDirs({ now });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(r).toMatchObject({ scanned: 2, removed: 1, kept: 1 });
  });

  it('age is the NEWEST entry: an old dir holding a fresh file survives', () => {
    const dir = sessionDir('busy', { 'old.json': '{}' }, now - 30 * DAY);
    writeFile(path.join(dir, 'token-usage-session.json'), '{}', now - 60 * 1000);
    const t = new Date(now - 30 * DAY);
    utimesSync(dir, t, t);

    sweepSessionDirs({ now });

    expect(existsSync(dir)).toBe(true);
  });

  it('caps the COUNT too: only the newest `keep` survive even when all are fresh', () => {
    for (let i = 0; i < 5; i += 1) sessionDir(`s${i}`, { 'a.json': '{}' }, now - i * 60 * 1000);

    const r = sweepSessionDirs({ now, keep: 2 });

    expect(readdirSync(path.join(stateDir, 'runtime', 'sessions')).sort()).toEqual(['s0', 's1']);
    expect(r).toMatchObject({ scanned: 5, removed: 3, kept: 2 });
  });

  it('never removes a protected (current) session, however old it looks', () => {
    const mine = sessionDir('mine', { 'a.json': '{}' }, now - 90 * DAY);
    const other = sessionDir('other', { 'a.json': '{}' }, now - 90 * DAY);

    sweepSessionDirs({ now, protect: ['mine'] });

    expect(existsSync(mine)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it('a protected session does not consume a `keep` slot it was not given', () => {
    sessionDir('mine', { 'a.json': '{}' }, now - 90 * DAY);
    for (let i = 0; i < 3; i += 1) sessionDir(`s${i}`, { 'a.json': '{}' }, now - i * 60 * 1000);

    sweepSessionDirs({ now, keep: 2, protect: ['mine'] });

    expect(readdirSync(path.join(stateDir, 'runtime', 'sessions')).sort()).toEqual(['mine', 's0', 's1']);
  });

  it('only touches directories it could have created: plain files and odd names are left alone', () => {
    const sessions = path.join(stateDir, 'runtime', 'sessions');
    writeFile(path.join(sessions, 'README.txt'), 'hello', now - 90 * DAY);
    const odd = path.join(sessions, 'not a session id');
    writeFile(path.join(odd, 'x.json'), '{}', now - 90 * DAY);
    const t = new Date(now - 90 * DAY);
    utimesSync(odd, t, t);

    const r = sweepSessionDirs({ now });

    expect(existsSync(path.join(sessions, 'README.txt'))).toBe(true);
    expect(existsSync(odd)).toBe(true);
    expect(r.removed).toBe(0);
  });

  it('is a no-op when sessions/ does not exist, and never throws', () => {
    expect(sweepSessionDirs({ now })).toEqual({ scanned: 0, removed: 0, kept: 0 });
  });

  it('ships sane defaults: 7 days, 256 dirs — and the default cap really bounds the directory', () => {
    expect(SESSION_DIR_MAX_AGE_MS).toBe(7 * DAY);
    expect(SESSION_DIR_KEEP).toBe(256);
    for (let i = 0; i < SESSION_DIR_KEEP + 20; i += 1) {
      sessionDir(`bulk-${i}`, { 'a.json': '{}' }, now - i * 1000);
    }

    sweepSessionDirs({ now });

    expect(readdirSync(path.join(stateDir, 'runtime', 'sessions'))).toHaveLength(SESSION_DIR_KEEP);
  });
});
