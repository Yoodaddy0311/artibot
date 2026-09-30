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
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
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

  it('agrees on the legacy directory, including when there is none to read', async () => {
    const root = path.join(tmp, 'pair-root');
    await bothUnder({ CLAUDE_PLUGIN_ROOT: root, ...homeEnv() });
    const cli = await import(CLI_URL);
    const store = await import('../../lib/autopilot/session-store.js');
    expect(cli.resolveLegacyStoreDir(undefined)).toBe(store.getLegacyStoreDir());
    expect(cli.resolveLegacyStoreDir(undefined)).toBe(path.join(root, 'runtime', 'autopilot'));

    await bothUnder({
      CLAUDE_PLUGIN_ROOT: root,
      ARTIBOT_AUTOPILOT_STORE_DIR: path.join(tmp, 'pair-store'),
      ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: root,
      ...homeEnv(),
    });
    // An honoured override names the store explicitly: there is no old location.
    expect(cli.resolveLegacyStoreDir(undefined)).toBeNull();
    expect(store.getLegacyStoreDir()).toBeNull();
    // `--dir` does too.
    expect(cli.resolveLegacyStoreDir(path.join(tmp, 'x'))).toBeNull();
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
    expect(path.resolve(r.json.inputPath)).toBe(path.resolve(legacy));
    expect(r.json.census.legacyFallback).toBe(true);
    expect(path.resolve(r.json.census.primaryStore)).toBe(path.resolve(defaultStoreOf(fakeHome)));
    expect(r.json.rows).toBe(3);
    expect(r.json.divergentTrue).toBe(2);
    expect(r.json.status).toBe('measured');
    expect(r.stderr).toContain('old location, not yet adopted');
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
    mkdirSync(store, { recursive: true });
    writeFileSync(path.join(store, 'legacy-migration.ledger'), '{"version":1,"entries":{}}\n', 'utf-8');

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
