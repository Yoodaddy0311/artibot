/**
 * The store `scripts/ledger/recovery-journal-census.mjs` reads — where it is
 * since owner decision D2 (2026-09-30), how the reader's copy of the resolver is
 * kept in step with the writer's, and what it does while the new store has not
 * yet adopted the old location.
 *
 * Split out of `recovery-journal-census.test.js` (which carries the counting
 * rule and the read-only assertions) so neither file outgrows the 800-line
 * quality gate. The helpers below are small copies of that file's, on purpose:
 * sharing them would make a change to the counting suite silently change what
 * this one asserts about resolution.
 *
 * WHAT THIS FILE CANNOT SEE (rules §9):
 *   - The installed copy of the script. These cases run the file in this
 *     worktree against fabricated directories.
 *   - The owner's live stores. The fallback is exercised against fixtures of a
 *     few hundred bytes; what the real old location holds on any given day is a
 *     measurement to take, not something a green run here establishes.
 *   - Two processes at once. The fallback decision is one `readdir` and one
 *     `stat`; a session adopted between them is simply counted on the next run.
 *
 * @module tests/ledger/recovery-journal-census-store
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Child processes are spawned below; the budget buys headroom for load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'recovery-journal-census.mjs');
const CLI_URL = `file://${CLI.split(path.sep).join('/')}`;

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'rjcs-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * An empty session store directory.
 *
 * @param {string} name
 * @returns {string}
 */
function makeStore(name) {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write one `{sessionId}.json` into a store.
 *
 * @param {string} dir
 * @param {object} state the whole session state object
 * @param {string} id
 * @returns {string} the session id
 */
function writeSession(dir, state, id) {
  writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(state)}\n`, 'utf-8');
  return id;
}

/**
 * Run the CLI. An `undefined` env value is not passed to the child at all.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} [env]
 * @returns {{status: number, stdout: string, stderr: string, json: object|null}}
 */
function run(argv, env = {}) {
  const out = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  let json = null;
  try { json = JSON.parse(out.stdout); } catch { /* left null; the caller asserts */ }
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, json };
}

/**
 * A snapshot of every file in a directory: name, size, mtime and bytes.
 *
 * @param {string} dir
 * @returns {Record<string,{size: number, mtimeMs: number, bytes: string}>}
 */
function snapshot(dir) {
  const snap = {};
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const st = statSync(file);
    snap[name] = { size: st.size, mtimeMs: st.mtimeMs, bytes: readFileSync(file, 'utf-8') };
  }
  return snap;
}

/**
 * An environment in which the DEFAULT store resolves under a fake home: every
 * variable that could move it is removed and the home is repointed, so nothing
 * of the developer's own state — the real `~/.claude/artibot`, nor the state dir
 * the test setup set — can leak into what the child resolves.
 *
 * @param {string} root the plugin root in force
 * @param {string} fakeHome
 * @returns {Record<string, string|undefined>}
 */
function defaultEnv(root, fakeHome) {
  return {
    CLAUDE_PLUGIN_ROOT: root,
    USERPROFILE: fakeHome,
    HOME: fakeHome,
    ARTIBOT_STATE_DIR: undefined,
    ARTIBOT_STATE_DIR_HOME: undefined,
    ARTIBOT_AUTOPILOT_STORE_DIR: undefined,
    ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: undefined,
  };
}

/** The default store under a fake home — `<home>/.claude/artibot/runtime/autopilot`. */
function defaultStoreOf(fakeHome) {
  return path.join(fakeHome, '.claude', 'artibot', 'runtime', 'autopilot');
}

describe('recovery-journal-census CLI: the mirrored resolver stays in step', () => {
  // `resolveStoreDir` is a deliberate COPY of
  // `lib/autopilot/session-store.js#getStoreDir`, and `resolveStateDir` a copy of
  // `lib/core/config.js#resolveArtibotDir` that the store now builds on: the
  // reader may not import the writer (the allowlist in the counting suite is what
  // forbids it), so the duplication is the price of the allowlist. A copy drifts
  // in silence, and the reader would go on reporting a confident denominator for
  // a directory the writer had left. These cases are the whole decision table of
  // BOTH env pairs (the store override's and the state dir's), and each asserts
  // the two resolvers AGREE before asserting what they agree on, so a drift stays
  // red even if both halves were moved to some third rule.
  const KEYS = [
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

  beforeEach(() => {
    savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /**
   * Apply one environment, then read both resolvers under exactly that one.
   *
   * @param {Record<string, string|undefined>} env
   * @returns {Promise<{mirror: string, canonical: string}>}
   */
  async function bothUnder(env) {
    for (const k of KEYS) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    const { resolveStoreDir } = await import(CLI_URL);
    const { getStoreDir } = await import('../../lib/autopilot/session-store.js');
    return { mirror: resolveStoreDir(), canonical: getStoreDir() };
  }

  /** A fake home, so nothing of the developer's own state can decide a case. */
  const homeEnv = () => ({
    USERPROFILE: path.join(tmp, 'pair-home'),
    HOME: path.join(tmp, 'pair-home'),
  });
  const storeUnderHome = () => path.join(tmp, 'pair-home', '.claude', 'artibot', 'runtime', 'autopilot');

  it('agrees on the state-dir default when no override is set', async () => {
    const root = path.join(tmp, 'pair-root');
    const { mirror, canonical } = await bothUnder({ CLAUDE_PLUGIN_ROOT: root, ...homeEnv() });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(storeUnderHome());
  });

  it('agrees that the plugin root no longer decides the default (D2)', async () => {
    const one = await bothUnder({ CLAUDE_PLUGIN_ROOT: path.join(tmp, 'pair-root-a'), ...homeEnv() });
    const two = await bothUnder({ CLAUDE_PLUGIN_ROOT: path.join(tmp, 'pair-root-b'), ...homeEnv() });
    expect(one.mirror).toBe(two.mirror);
    expect(one.canonical).toBe(two.canonical);
    expect(one.mirror).toBe(one.canonical);
  });

  it('agrees on discarding an override with no recorded root', async () => {
    const root = path.join(tmp, 'pair-root');
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: path.join(tmp, 'pair-store'),
      ...homeEnv(),
    });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(storeUnderHome());
  });

  it('agrees on honouring an override minted for the root in force', async () => {
    const root = path.join(tmp, 'pair-root');
    const store = path.join(tmp, 'pair-store');
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: store,
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: root,
      ...homeEnv(),
    });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(path.resolve(store));
  });

  it('agrees on discarding an override minted for a different root', async () => {
    const root = path.join(tmp, 'pair-root');
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: path.join(tmp, 'pair-store'),
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: path.join(tmp, 'pair-other'),
      ...homeEnv(),
    });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(storeUnderHome());
  });

  it('agrees on honouring ARTIBOT_STATE_DIR minted for the home in force', async () => {
    const stateDir = path.join(tmp, 'pair-state');
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: path.join(tmp, 'pair-root'),
      ARTIBOT_STATE_DIR: stateDir,
      ARTIBOT_STATE_DIR_HOME: path.join(tmp, 'pair-home'),
      ...homeEnv(),
    });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(path.join(stateDir, 'runtime', 'autopilot'));
  });

  it('agrees on discarding ARTIBOT_STATE_DIR with no recorded home', async () => {
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: path.join(tmp, 'pair-root'),
      ARTIBOT_STATE_DIR: path.join(tmp, 'pair-state'),
      ...homeEnv(),
    });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(storeUnderHome());
  });

  it('agrees on discarding ARTIBOT_STATE_DIR minted for a different home', async () => {
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: path.join(tmp, 'pair-root'),
      ARTIBOT_STATE_DIR: path.join(tmp, 'pair-state'),
      ARTIBOT_STATE_DIR_HOME: path.join(tmp, 'some-other-home'),
      ...homeEnv(),
    });
    expect(mirror).toBe(canonical);
    expect(mirror).toBe(storeUnderHome());
  });

  it('agrees when only ONE of the two home variables moved (the POSIX idiom)', async () => {
    // `getHomeDir()` prefers USERPROFILE, so a child handed HOME alone moves its
    // home without moving the value a single-variable compare would read.
    const stateDir = path.join(tmp, 'pair-state');
    const { mirror, canonical } = await bothUnder({
      CLAUDE_PLUGIN_ROOT: path.join(tmp, 'pair-root'),
      ARTIBOT_STATE_DIR: stateDir,
      ARTIBOT_STATE_DIR_HOME: path.join(tmp, 'pair-home'),
      USERPROFILE: path.join(tmp, 'pair-home'),
      HOME: path.join(tmp, 'a-different-home'),
    });
    expect(mirror).toBe(canonical);
    expect(mirror).not.toBe(path.join(stateDir, 'runtime', 'autopilot'));
  });

  it('keeps the ledger name, which marks "this store has adopted the old location", in step', async () => {
    const { LEGACY_LEDGER_NAME } = await import(CLI_URL);
    const store = await import('../../lib/autopilot/session-store.js');
    expect(LEGACY_LEDGER_NAME).toBe(store.LEGACY_LEDGER_NAME);
  });

  /**
   * A fake host: cached versions (two of which a string sort gets backwards), a
   * marketplace mirror that is a git clone, and a developer checkout — every one
   * with a `runtime/autopilot` directory.
   */
  function hostLayout() {
    const fakeHome = path.join(tmp, 'pair-home');
    const cache = path.join(fakeHome, '.claude', 'plugins', 'cache', 'artibot', 'artibot');
    const versions = {};
    for (const v of ['4.70.0', '4.9.0', '4.10.0', '4.71.0', 'latest']) {
      versions[v] = path.join(cache, v);
      mkdirSync(path.join(versions[v], 'runtime', 'autopilot'), { recursive: true });
    }
    const clone = path.join(fakeHome, '.claude', 'plugins', 'marketplaces', 'artibot');
    mkdirSync(path.join(clone, '.git'), { recursive: true });
    const mirror = path.join(clone, 'plugins', 'artibot');
    mkdirSync(path.join(mirror, 'runtime', 'autopilot'), { recursive: true });
    const devRepo = path.join(tmp, 'dev-repo');
    mkdirSync(path.join(devRepo, '.git'), { recursive: true });
    const dev = path.join(devRepo, 'plugins', 'artibot');
    mkdirSync(path.join(dev, 'runtime', 'autopilot'), { recursive: true });
    return { versions, mirror, dev };
  }

  it('agrees on the legacy directories — the running root, versions newest first, the mirror', async () => {
    const { versions } = hostLayout();
    await bothUnder({ CLAUDE_PLUGIN_ROOT: versions['4.70.0'], ...homeEnv() });
    const cli = await import(CLI_URL);
    const store = await import('../../lib/autopilot/session-store.js');

    const mirror = cli.resolveLegacyStoreDirs(undefined);
    expect(mirror).toEqual(store.getLegacyStoreDirs());
    // 4.10.0 is newer than 4.9.0; the running root leads; `latest` is not a version.
    expect(mirror.map((d) => path.basename(path.dirname(path.dirname(d))))).toEqual([
      '4.70.0', '4.71.0', '4.10.0', '4.9.0', 'latest', 'artibot',
    ]);
  });

  it('agrees that a developer checkout is never a source, and that installed versions still are', async () => {
    const { dev } = hostLayout();
    await bothUnder({ CLAUDE_PLUGIN_ROOT: dev, ...homeEnv() });
    const cli = await import(CLI_URL);
    const store = await import('../../lib/autopilot/session-store.js');

    const sources = cli.resolveLegacyStoreDirs(undefined);
    expect(sources).toEqual(store.getLegacyStoreDirs());
    expect(sources).not.toContain(path.join(dev, 'runtime', 'autopilot'));
    expect(sources.length).toBe(6); // five cached versions + the mirror
  });

  it('agrees when the mirror itself is the running root', async () => {
    const { mirror } = hostLayout();
    await bothUnder({ CLAUDE_PLUGIN_ROOT: mirror, ...homeEnv() });
    const cli = await import(CLI_URL);
    const store = await import('../../lib/autopilot/session-store.js');

    expect(cli.resolveLegacyStoreDirs(undefined)).toEqual(store.getLegacyStoreDirs());
    expect(cli.resolveLegacyStoreDirs(undefined)[0]).toBe(path.join(mirror, 'runtime', 'autopilot'));
  });

  it('agrees that a redirected state dir scans only the running root', async () => {
    const { versions } = hostLayout();
    await bothUnder({
      CLAUDE_PLUGIN_ROOT: versions['4.71.0'],
      ARTIBOT_STATE_DIR: path.join(tmp, 'pair-state'),
      ARTIBOT_STATE_DIR_HOME: path.join(tmp, 'pair-home'),
      ...homeEnv(),
    });
    const cli = await import(CLI_URL);
    const store = await import('../../lib/autopilot/session-store.js');

    expect(cli.resolveLegacyStoreDirs(undefined)).toEqual(store.getLegacyStoreDirs());
    expect(cli.resolveLegacyStoreDirs(undefined)).toEqual([path.join(versions['4.71.0'], 'runtime', 'autopilot')]);
  });

  it('agrees there is nothing to read when an override names the store, or --dir does', async () => {
    const { versions } = hostLayout();
    await bothUnder({
      CLAUDE_PLUGIN_ROOT: versions['4.70.0'],
      ARTIBOT_AUTOPILOT_STORE_DIR: path.join(tmp, 'pair-store'),
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: versions['4.70.0'],
      ...homeEnv(),
    });
    const cli = await import(CLI_URL);
    const store = await import('../../lib/autopilot/session-store.js');

    // An honoured override names the store explicitly: there is no old location.
    expect(cli.resolveLegacyStoreDirs(undefined)).toEqual([]);
    expect(store.getLegacyStoreDirs()).toEqual([]);
    // `--dir` does too.
    expect(cli.resolveLegacyStoreDirs(path.join(tmp, 'x'))).toEqual([]);
  });
});

describe('recovery-journal-census CLI: the old location, read while the new store has adopted nothing', () => {
  /** Session files at the OLD place, `<plugin root>/runtime/autopilot`. */
  function makeLegacy(root) {
    const dir = path.join(root, 'runtime', 'autopilot');
    mkdirSync(dir, { recursive: true });
    writeSession(dir, { sessionId: 'old-a', recoveryJournal: [{ divergent: true }, { divergent: false }] }, 'old-a');
    writeSession(dir, { sessionId: 'old-b', recoveryJournal: [{ divergent: true }] }, 'old-b');
    return dir;
  }

  it('reads the old location when the new store is absent, and says so in the report', () => {
    const root = path.join(tmp, 'legacy-root');
    const fakeHome = path.join(tmp, 'legacy-home');
    const legacy = makeLegacy(root);

    const r = run([], defaultEnv(root, fakeHome));

    expect(r.status).toBe(0);
    expect(r.json.ok).toBe(true);
    // `inputPath` is the store the run DESCRIBES; `readFrom` is where the numbers came from.
    expect(path.resolve(r.json.inputPath)).toBe(path.resolve(defaultStoreOf(fakeHome)));
    expect(r.json.census.readFrom.map((d) => path.resolve(d))).toEqual([path.resolve(legacy)]);
    expect(r.json.census.legacyFallback).toBe(true);
    expect(r.json.rows).toBe(3);
    expect(r.json.divergentTrue).toBe(2);
    expect(r.json.status).toBe('measured');
    expect(r.stderr).toContain('not yet adopted');
  });

  it('reads the store itself, and says so, when it is the store that holds the sessions', () => {
    const root = path.join(tmp, 'plain-root');
    const fakeHome = path.join(tmp, 'plain-home');
    mkdirSync(root, { recursive: true });
    const store = defaultStoreOf(fakeHome);
    mkdirSync(store, { recursive: true });
    writeSession(store, { sessionId: 'a', recoveryJournal: [{ divergent: true }] }, 'a');

    const r = run([], defaultEnv(root, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(false);
    expect(r.census.readFrom.map((d) => path.resolve(d))).toEqual([path.resolve(store)]);
  });

  it('also reads it when the new store directory exists but holds no session yet', () => {
    const root = path.join(tmp, 'legacy-root2');
    const fakeHome = path.join(tmp, 'legacy-home2');
    makeLegacy(root);
    mkdirSync(defaultStoreOf(fakeHome), { recursive: true });

    const r = run([], defaultEnv(root, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(true);
    expect(r.rows).toBe(3);
  });

  it('does NOT fall back once the new store holds a session of its own', () => {
    const root = path.join(tmp, 'legacy-root3');
    const fakeHome = path.join(tmp, 'legacy-home3');
    makeLegacy(root);
    const store = defaultStoreOf(fakeHome);
    mkdirSync(store, { recursive: true });
    writeSession(store, { sessionId: 'new-a', recoveryJournal: [{ divergent: false }] }, 'new-a');

    const r = run([], defaultEnv(root, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(false);
    expect(path.resolve(r.inputPath)).toBe(path.resolve(store));
    expect(r.rows).toBe(1);
  });

  it('does NOT fall back for a store that has adopted (ledger present), even when it is empty', () => {
    // A session the user deleted must not reappear in a count just because the
    // old location still holds the file.
    const root = path.join(tmp, 'legacy-root4');
    const fakeHome = path.join(tmp, 'legacy-home4');
    makeLegacy(root);
    const store = defaultStoreOf(fakeHome);
    // The ledger is a directory of per-id marker files; one marker is enough to
    // say "this store has adopted", and the session it names is long deleted.
    mkdirSync(path.join(store, 'legacy-migration.ledger'), { recursive: true });
    writeFileSync(path.join(store, 'legacy-migration.ledger', 'session.old-a'), '{"how":"copied"}\n', 'utf-8');

    const r = run([], defaultEnv(root, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.status).toBe('unmeasured:no-store');
  });

  it('does NOT fall back when --dir or an honoured override names the store', () => {
    const root = path.join(tmp, 'legacy-root5');
    const fakeHome = path.join(tmp, 'legacy-home5');
    makeLegacy(root);
    const named = makeStore('named-empty');

    const viaDir = run(['--dir', named], defaultEnv(root, fakeHome)).json;
    expect(viaDir.census.legacyFallback).toBe(false);
    expect(viaDir.rows).toBe(0);

    const viaOverride = run([], {
      ...defaultEnv(root, fakeHome),
      ARTIBOT_AUTOPILOT_STORE_DIR: named,
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: root,
    }).json;
    expect(viaOverride.census.legacyFallback).toBe(false);
    expect(path.resolve(viaOverride.inputPath)).toBe(path.resolve(named));
  });

  it('reports no-store, not a borrowed count, when the old location has no session either', () => {
    const root = path.join(tmp, 'legacy-root6');
    const fakeHome = path.join(tmp, 'legacy-home6');
    mkdirSync(path.join(root, 'runtime', 'autopilot'), { recursive: true });

    const r = run([], defaultEnv(root, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('unmeasured:no-store');
  });

  it('stays read-only through the fallback: neither directory changes, nothing is created', () => {
    const root = path.join(tmp, 'legacy-root7');
    const fakeHome = path.join(tmp, 'legacy-home7');
    const legacy = makeLegacy(root);
    const before = snapshot(legacy);

    const out = run([], defaultEnv(root, fakeHome));

    expect(out.json.census.legacyFallback).toBe(true);
    expect(snapshot(legacy)).toEqual(before);
    expect(() => statSync(defaultStoreOf(fakeHome))).toThrow();
    expect(() => statSync(fakeHome)).toThrow();
  });

  it('judges "empty" on the whole store, not on what --session leaves of it', () => {
    // A populated store that merely lacks the named session is not an empty one;
    // borrowing the old location's answer for it would describe another store.
    const root = path.join(tmp, 'legacy-root9');
    const fakeHome = path.join(tmp, 'legacy-home9');
    makeLegacy(root);
    const store = defaultStoreOf(fakeHome);
    mkdirSync(store, { recursive: true });
    writeSession(store, { sessionId: 'new-a', recoveryJournal: [{ divergent: false }] }, 'new-a');

    const r = run(['--session', 'old-b'], defaultEnv(root, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.status).toBe('unmeasured:no-store');
  });

  it('--session narrows the fallback read to one old file too', () => {
    const root = path.join(tmp, 'legacy-root8');
    const fakeHome = path.join(tmp, 'legacy-home8');
    makeLegacy(root);

    const r = run(['--session', 'old-b'], defaultEnv(root, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(true);
    expect(r.rows).toBe(1);
    expect(r.census.perSession).toEqual([{ sessionId: 'old-b', rows: 1 }]);
  });
});

describe('recovery-journal-census CLI: the old locations, all of them', () => {
  // The adoption reads every cached version and the marketplace mirror, not just
  // the plugin root in force (review of 6b410964, SHOULD 2). A census that read
  // only the running root would still print `no-store` over a denominator that
  // exists whenever the sessions sit in an older version directory.
  const cacheVersion = (fakeHome, version) => path.join(
    fakeHome, '.claude', 'plugins', 'cache', 'artibot', 'artibot', version,
  );

  function seed(root, sessions) {
    const dir = path.join(root, 'runtime', 'autopilot');
    mkdirSync(dir, { recursive: true });
    for (const [id, state] of Object.entries(sessions)) writeSession(dir, { sessionId: id, ...state }, id);
    return dir;
  }

  const rows = (n) => ({ recoveryJournal: Array.from({ length: n }, () => ({ divergent: true })) });

  it('counts a session that exists only in an OLDER version directory', () => {
    const fakeHome = path.join(tmp, 'all-home1');
    const running = cacheVersion(fakeHome, '4.71.0');
    mkdirSync(running, { recursive: true });
    const older = seed(cacheVersion(fakeHome, '4.68.0'), { 'only-old': rows(2) });

    const r = run([], defaultEnv(running, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(true);
    expect(r.rows).toBe(2);
    expect(r.census.readFrom.map((d) => path.resolve(d))).toEqual([path.resolve(older)]);
  });

  it('counts the marketplace mirror, which is a git clone but not a developer checkout', () => {
    const fakeHome = path.join(tmp, 'all-home2');
    const running = cacheVersion(fakeHome, '4.71.0');
    mkdirSync(running, { recursive: true });
    const clone = path.join(fakeHome, '.claude', 'plugins', 'marketplaces', 'artibot');
    mkdirSync(path.join(clone, '.git'), { recursive: true });
    seed(path.join(clone, 'plugins', 'artibot'), { 'in-mirror': rows(3) });

    const r = run([], defaultEnv(running, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(true);
    expect(r.rows).toBe(3);
  });

  it('counts each session id ONCE, from the freshest copy, however many directories hold it', () => {
    const fakeHome = path.join(tmp, 'all-home3');
    const running = cacheVersion(fakeHome, '4.71.0');
    mkdirSync(running, { recursive: true });
    const newerDir = seed(cacheVersion(fakeHome, '4.70.0'), { dup: rows(1) });
    const olderDir = seed(cacheVersion(fakeHome, '4.69.0'), { dup: rows(5) });
    // The older directory's copy is the fresher one (a build still running there).
    const past = new Date('2026-09-01T00:00:00Z');
    const recent = new Date('2026-09-20T00:00:00Z');
    utimesSync(path.join(newerDir, 'dup.json'), past, past);
    utimesSync(path.join(olderDir, 'dup.json'), recent, recent);

    const r = run([], defaultEnv(running, fakeHome)).json;

    expect(r.census.perSession).toEqual([{ sessionId: 'dup', rows: 5 }]);
    expect(r.rows).toBe(5);
  });

  it('never counts a developer checkout: its old store holds sessions the test suite wrote', () => {
    const fakeHome = path.join(tmp, 'all-home4');
    const devRepo = path.join(tmp, 'all-dev-repo');
    mkdirSync(path.join(devRepo, '.git'), { recursive: true });
    const dev = path.join(devRepo, 'plugins', 'artibot');
    seed(dev, { 'test-origin': rows(9) });

    const r = run([], defaultEnv(dev, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.status).toBe('unmeasured:no-store');
  });

  it('still counts the installed versions when a developer checkout is the running root', () => {
    const fakeHome = path.join(tmp, 'all-home5');
    const devRepo = path.join(tmp, 'all-dev-repo5');
    mkdirSync(path.join(devRepo, '.git'), { recursive: true });
    const dev = path.join(devRepo, 'plugins', 'artibot');
    seed(dev, { 'test-origin': rows(9) });
    seed(cacheVersion(fakeHome, '4.70.0'), { installed: rows(2) });

    const r = run([], defaultEnv(dev, fakeHome)).json;

    expect(r.census.legacyFallback).toBe(true);
    expect(r.census.perSession).toEqual([{ sessionId: 'installed', rows: 2 }]);
  });

  it('reads only the running root while the state dir is redirected', () => {
    const fakeHome = path.join(tmp, 'all-home6');
    const running = cacheVersion(fakeHome, '4.71.0');
    seed(running, { 'in-running': rows(1) });
    seed(cacheVersion(fakeHome, '4.68.0'), { 'in-older': rows(7) });

    const r = run([], {
      ...defaultEnv(running, fakeHome),
      ARTIBOT_STATE_DIR: path.join(tmp, 'all-state6'),
      ARTIBOT_STATE_DIR_HOME: fakeHome,
    }).json;

    expect(r.census.perSession).toEqual([{ sessionId: 'in-running', rows: 1 }]);
  });

  it('stays read-only across every directory it reads', () => {
    const fakeHome = path.join(tmp, 'all-home7');
    const running = cacheVersion(fakeHome, '4.71.0');
    mkdirSync(running, { recursive: true });
    const a = seed(cacheVersion(fakeHome, '4.70.0'), { one: rows(1) });
    const b = seed(cacheVersion(fakeHome, '4.69.0'), { two: rows(2) });
    const before = [snapshot(a), snapshot(b)];

    const r = run([], defaultEnv(running, fakeHome)).json;

    expect(r.rows).toBe(3);
    expect([snapshot(a), snapshot(b)]).toEqual(before);
    expect(() => statSync(defaultStoreOf(fakeHome))).toThrow();
  });
});
