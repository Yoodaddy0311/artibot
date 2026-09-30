/**
 * Unit tests for lib/autopilot/session-store.js
 * Covers newSessionId, save/load roundtrip, listSessions, deleteSession.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteSession, deleteSessionArtifacts,
  getSessionPath,
  getStoreDir,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
} from '../../lib/autopilot/session-store.js';
import { resolveArtibotDir } from '../../lib/core/config.js';
import { getHomeDir, getPluginRoot, sameDirPath } from '../../lib/core/platform.js';

describe('newSessionId', () => {
  it('returns ap-YYYYMMDD-HHMMSS-xxxxxx format with random suffix', () => {
    const id = newSessionId();
    expect(id).toMatch(/^ap-\d{8}-\d{6}-[a-z0-9]{6}$/);
  });

  it('returns a string starting with "ap-"', () => {
    const id = newSessionId();
    expect(id.startsWith('ap-')).toBe(true);
  });

  it('produces unique ids across rapid successive calls (collision safety)', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i += 1) ids.add(newSessionId());
    expect(ids.size).toBe(200);
  });
});

describe('saveSession / loadSession roundtrip', () => {
  const sessions = [];

  afterEach(() => {
    while (sessions.length) {
      const id = sessions.pop();
      try { deleteSessionArtifacts(id); } catch { /* ignore */ }
    }
  });

  it('persists and restores session with Korean task field', () => {
    const sessionId = `ap-test-${Date.now()}-roundtrip`;
    sessions.push(sessionId);
    const state = {
      sessionId,
      task: '한글 작업 설명: 자동 모드 테스트',
      status: 'running',
      counters: { buildFailures: 0, testFailures: 1 },
      createdAt: new Date().toISOString(),
    };
    const writtenPath = saveSession(state);
    expect(writtenPath).toBe(getSessionPath(sessionId));

    const loaded = loadSession(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded.sessionId).toBe(sessionId);
    expect(loaded.task).toBe('한글 작업 설명: 자동 모드 테스트');
    expect(loaded.counters.testFailures).toBe(1);
  });

  it('returns null when loading nonexistent session', () => {
    expect(loadSession('ap-nonexistent-xyz-99999999')).toBeNull();
  });

  it('throws when saving without sessionId', () => {
    expect(() => saveSession({ task: 'x' })).toThrow();
  });
});

describe('listSessions / deleteSession', () => {
  it('listSessions includes a freshly saved session', () => {
    const sessionId = `ap-test-${Date.now()}-list`;
    saveSession({ sessionId, task: 'list test' });
    try {
      const list = listSessions();
      expect(Array.isArray(list)).toBe(true);
      expect(list).toContain(sessionId);
    } finally {
      deleteSession(sessionId);
    }
  });

  it('deleteSession returns true for existing, false for missing', () => {
    const sessionId = `ap-test-${Date.now()}-del`;
    saveSession({ sessionId, task: 'del test' });
    expect(deleteSession(sessionId)).toBe(true);
    expect(deleteSession(sessionId)).toBe(false);
  });
});

describe('getStoreDir env seam', () => {
  const VAR = 'ARTIBOT_AUTOPILOT_STORE_DIR';
  const PAIR = 'ARTIBOT_AUTOPILOT_STORE_DIR_ROOT';
  const PLUGIN_ROOT_VAR = 'CLAUDE_PLUGIN_ROOT';
  /** @type {{ dir: string | undefined, root: string | undefined, plugin: string | undefined }} */
  let saved;
  /** @type {string | null} */
  let fakeRoot = null;

  /** Restore one variable to its pre-test value; absent means absent, not ''. */
  const restore = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  /** The store the DEFAULT resolution lands on since D2: under the state dir. */
  const stateDerivedStore = () => path.join(resolveArtibotDir(), 'runtime', 'autopilot');

  /**
   * Point the plugin root at an empty temp dir. Cases that drop the override
   * resolve the DEFAULT store, and the first such call per process adopts the
   * legacy store under the plugin root in force — which, left at the real one,
   * is this checkout's own `runtime/autopilot`. A fake root keeps a path-only
   * test from copying real sessions anywhere.
   */
  const useFakePluginRoot = () => {
    fakeRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-seam-root-'));
    writeFileSync(path.join(fakeRoot, 'artibot.config.json'), '{}', 'utf-8');
    process.env[PLUGIN_ROOT_VAR] = fakeRoot;
  };

  beforeEach(() => {
    saved = { dir: process.env[VAR], root: process.env[PAIR], plugin: process.env[PLUGIN_ROOT_VAR] };
  });

  // Restoring matters beyond tidiness: the global setup turns these two on by
  // default, so leaking a deleted/rewritten value here would send a later test
  // in the same worker at the real store.
  afterEach(() => {
    restore(VAR, saved.dir);
    restore(PAIR, saved.root);
    restore(PLUGIN_ROOT_VAR, saved.plugin);
    if (fakeRoot) rmSync(fakeRoot, { recursive: true, force: true });
    fakeRoot = null;
  });

  // The only LIVE assertion that executes inside the `autopilot` vitest project.
  //
  // Everything else about this seam is pinned from the `main` project by
  // `tests/firewall/autopilot-store-sandbox-required.test.js`, and that gate
  // cannot observe these workers. The autopilot project is a separate entry in
  // `vitest.config.js` that inherits the global `setupFiles` only through
  // `extends: true`; if that inheritance is dropped or `setupFiles` is
  // redeclared inside the project, the firewall stays entirely green while
  // every file in this directory writes to the real store. This `it` is what
  // goes red instead.
  //
  // It runs BEFORE the cases below touch the environment, and `beforeEach` only
  // reads while `afterEach` restores, so it observes whatever the global setup
  // left in place no matter what order the file's tests are run in.
  it('is redirected away from the real store by global setup (autopilot project)', () => {
    expect(process.env[VAR]).toBeTruthy();
    // The real store is the one a user's machine has: under the real home, not
    // under whatever `ARTIBOT_STATE_DIR` the setup also redirected.
    const realStore = path.join(getHomeDir(), '.claude', 'artibot', 'runtime', 'autopilot');
    expect(sameDirPath(getStoreDir(), realStore)).toBe(false);
  });

  it('returns the override when its paired root is the plugin root in force', () => {
    const sandbox = path.join(getPluginRoot(), '.tmp-store-seam', 'autopilot');
    process.env[VAR] = sandbox;
    process.env[PAIR] = getPluginRoot();
    expect(getStoreDir()).toBe(sandbox);
  });

  // Regression: an operator spelling the override with forward slashes — the
  // Git Bash idiom — used to get it back verbatim, while every consumer joined
  // onto it and got the platform separator. `telemetry.js#getEventsPath` then
  // produced a path that was genuinely inside the store yet failed a
  // `startsWith(getStoreDir())` string compare (measured 2026-09-21: that one
  // assertion red under a slash-spelled override, green under the same
  // directory spelled with backslashes).
  it('normalizes the override to an absolute path in the platform spelling', () => {
    const sandbox = path.join(getPluginRoot(), '.tmp-store-seam', 'autopilot');
    process.env[PAIR] = getPluginRoot();

    // Identity on POSIX, where the joined form already uses `/`; the separator
    // swap that matters is win32's. Comparing against the joined form rather
    // than against the input is what makes the assertion meaningful on both.
    process.env[VAR] = sandbox.split(path.sep).join('/');
    expect(getStoreDir()).toBe(sandbox);

    // A relative override resolves against cwd — the same directory fs would
    // have used anyway, now stated absolutely so consumers can compare paths.
    process.env[VAR] = path.join('.', '.tmp-store-seam-relative');
    expect(path.isAbsolute(getStoreDir())).toBe(true);
    expect(getStoreDir()).toBe(path.resolve('.tmp-store-seam-relative'));
  });

  it('discards the override when the paired root is absent or a different dir', () => {
    useFakePluginRoot();
    const fallback = stateDerivedStore();
    process.env[VAR] = path.join(getPluginRoot(), '.tmp-store-seam', 'autopilot');

    delete process.env[PAIR];
    expect(getStoreDir()).toBe(fallback);

    process.env[PAIR] = path.join(getPluginRoot(), 'some', 'other', 'root');
    expect(getStoreDir()).toBe(fallback);

    process.env[PAIR] = '';
    expect(getStoreDir()).toBe(fallback);
  });

  it('returns the state-dir path (not a plugin-root path) when neither variable is set', () => {
    useFakePluginRoot();
    delete process.env[VAR];
    delete process.env[PAIR];
    expect(getStoreDir()).toBe(stateDerivedStore());
    // The regression D2 closes: the store must not follow the plugin root.
    expect(sameDirPath(getStoreDir(), path.join(getPluginRoot(), 'runtime', 'autopilot'))).toBe(false);
  });
});
