import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _resetPathCache,
  configureProfilePath,
  detectSkillLevel,
  getProfile,
  recordSignal,
  resolveProfilePath,
  setSkillLevel,
} from '../../lib/core/user-profile.js';
import { resolveArtibotDir } from '../../lib/core/config.js';
import { getHomeDir, getPluginRoot } from '../../lib/core/platform.js';
import {
  readDecisionEvents,
  recordSkillLevelChanged,
  resetDecisionRecorderStats,
  SKILL_LEVEL_CHANGED,
} from '../../lib/observability/decision-events.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

// D9 (2026-09-05): a novice->pro promotion no longer touches the decision
// trail. `recordSignal` reports the transition through its `recordChange` port
// and writes nothing itself, so no trail sandbox is needed here any more. The
// one case that binds the port to the real recorder pins the store to a
// throwaway `storeDir` (decision-events.js#getDecisionStoreDir).

const TMP_ROOT = join(tmpdir(), 'artibot-user-profile-tests');

function uniquePath() {
  const p = join(TMP_ROOT, `profile-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return p;
}

describe('user-profile', () => {
  let profilePath;

  beforeEach(() => {
    mkdirSync(TMP_ROOT, { recursive: true });
    profilePath = uniquePath();
    configureProfilePath(profilePath);
  });

  afterEach(() => {
    try {
      if (profilePath && existsSync(profilePath)) rmSync(profilePath);
    } catch { /* ignore */ }
    _resetPathCache();
  });

  describe('getProfile()', () => {
    it('returns novice by default when no profile file exists', async () => {
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
      expect(Array.isArray(p.evidence)).toBe(true);
      expect(typeof p.updatedAt).toBe('string');
    });

    it('reports insufficient-signal evidence for fresh profiles', async () => {
      const p = await getProfile();
      expect(p.evidence.some((e) => e.includes('insufficient signals'))).toBe(true);
    });
  });

  describe('recordSignal()', () => {
    it('persists signals to disk', async () => {
      await recordSignal({ type: 'slash-command', value: 'implement', timestamp: Date.now() });
      expect(existsSync(profilePath)).toBe(true);
    });

    it('ignores malformed signals without throwing', async () => {
      await recordSignal(null);
      await recordSignal({ type: 'unknown', value: 'x' });
      await recordSignal({});
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
    });

    it('promotes to pro after 10+ slash-command signals with jargon', async () => {
      for (let i = 0; i < 12; i++) {
        await recordSignal({
          type: 'slash-command',
          value: `refactor async api hook commit ${i}`,
          timestamp: Date.now() + i,
        });
      }
      const p = await getProfile();
      expect(p.skillLevel).toBe('pro');
      expect(p.evidence.some((e) => e.startsWith('slash-ratio='))).toBe(true);
    });

    it('reports a skill-level transition through the recordChange port', async () => {
      const changes = [];
      const recordChange = (change) => { changes.push(change); };
      for (let i = 0; i < 12; i++) {
        await recordSignal({
          type: 'slash-command',
          value: `refactor async api hook commit ${i}`,
          timestamp: Date.now() + i,
        }, { recordChange });
      }
      // One transition, reported once — later signals keep the level and stay silent.
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ from: 'novice', to: 'pro' });
      expect(changes[0].signals).toBeGreaterThanOrEqual(10);
      expect(changes[0].evidence.some((e) => e.startsWith('slash-ratio='))).toBe(true);
    });

    it('does not call the port when the level does not change', async () => {
      const recordChange = () => { throw new Error('must not be called'); };
      await recordSignal({ type: 'natural-language', value: 'hello', timestamp: Date.now() }, { recordChange });
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
    });

    it('swallows a throwing port — the record is advisory, the profile write is not', async () => {
      const recordChange = () => { throw new Error('recorder down'); };
      for (let i = 0; i < 12; i++) {
        await recordSignal({
          type: 'slash-command',
          value: `refactor async api hook commit ${i}`,
          timestamp: Date.now() + i,
        }, { recordChange });
      }
      const p = await getProfile();
      expect(p.skillLevel).toBe('pro');
    });

    it('lands in the decisions store when the port is the real D9 recorder', async () => {
      // The wiring `scripts/hooks/runtime-prompt.js#recordPromptSignals` does:
      // bind recordSkillLevelChanged to a session and a store, hand it in.
      const storeDir = mkdtempSync(join(tmpdir(), 'artibot-profile-store-'));
      resetDecisionRecorderStats();
      try {
        const recordChange = (change) => recordSkillLevelChanged('sess-profile-01', change, { storeDir });
        for (let i = 0; i < 12; i++) {
          await recordSignal({
            type: 'slash-command',
            value: `refactor async api hook commit ${i}`,
            timestamp: Date.now() + i,
          }, { recordChange });
        }
        const events = readDecisionEvents('sess-profile-01', { storeDir });
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe(SKILL_LEVEL_CHANGED);
        expect(events[0].data).toMatchObject({ from: 'novice', to: 'pro' });
      } finally {
        rmSync(storeDir, { recursive: true, force: true });
        resetDecisionRecorderStats();
      }
    });

    it('stays novice when user asks natural-language questions', async () => {
      const phrase = '\uC5B4\uB5BB\uAC8C \uD574\uC694';
      for (let i = 0; i < 12; i++) {
        await recordSignal({
          type: 'natural-language',
          value: `${phrase} ${i}`,
          timestamp: Date.now() + i,
        });
      }
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
    });

    it('truncates very long signal values', async () => {
      const longValue = 'x'.repeat(1000);
      await recordSignal({ type: 'natural-language', value: longValue });
      // Should persist without error
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
    });
  });

  describe('setSkillLevel()', () => {
    it('applies explicit override', async () => {
      await setSkillLevel('pro');
      const p = await getProfile();
      expect(p.skillLevel).toBe('pro');
      expect(p.evidence.some((e) => e.includes('explicit'))).toBe(true);
    });

    it('explicit override survives subsequent novice-like signals', async () => {
      await setSkillLevel('pro');
      for (let i = 0; i < 5; i++) {
        await recordSignal({ type: 'natural-language', value: '\uC5B4\uB5BB\uAC8C \uD574\uC694' });
      }
      const p = await getProfile();
      expect(p.skillLevel).toBe('pro');
    });

    it('null argument clears explicit override', async () => {
      await setSkillLevel('pro');
      await setSkillLevel(null);
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
    });

    it('ignores invalid values', async () => {
      await setSkillLevel('super-pro');
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
    });
  });

  describe('detectSkillLevel()', () => {
    it('returns novice initially', async () => {
      expect(await detectSkillLevel()).toBe('novice');
    });

    it('returns pro after explicit override', async () => {
      await setSkillLevel('pro');
      expect(await detectSkillLevel()).toBe('pro');
    });
  });

  describe('configureProfilePath()', () => {
    it('expands ~ to home directory', async () => {
      configureProfilePath('~/tmp-artibot-profile-unused.json');
      // Should not throw; read falls back to default profile on missing file.
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
    });

    it('accepts absolute paths', async () => {
      const explicit = uniquePath();
      configureProfilePath(explicit);
      await recordSignal({ type: 'slash-command', value: 'test' });
      expect(existsSync(explicit)).toBe(true);
      try { rmSync(explicit); } catch { /* ignore */ }
    });

    it('resolves relative paths against the artibot STATE dir (not CWD, not the plugin root)', async () => {
      // Write to a relative path — the module must anchor it to the state dir
      // (`~/.claude/artibot`, O2) so it resolves to the same file regardless of
      // process.cwd() AND of which plugin build is running: a marketplace install's
      // plugin root is a version-scoped cache directory that an update replaces.
      const relPath = `runtime/__test__/user-profile-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      const expected = join(resolveArtibotDir(), relPath);
      configureProfilePath(relPath);
      expect(resolveProfilePath()).toBe(expected);
      await recordSignal({ type: 'slash-command', value: 'test' });
      expect(existsSync(expected)).toBe(true);
      expect(existsSync(join(getPluginRoot(), relPath))).toBe(false);
      try { rmSync(expected); } catch { /* ignore */ }
    });

    it('keeps absolute paths unchanged and does not prepend the plugin root', async () => {
      const explicit = uniquePath();
      expect(isAbsolute(explicit)).toBe(true);
      configureProfilePath(explicit);
      await recordSignal({ type: 'slash-command', value: 'test' });
      expect(existsSync(explicit)).toBe(true);
      // must NOT have been re-rooted under the plugin dir
      expect(explicit.startsWith(getPluginRoot())).toBe(false);
      try { rmSync(explicit); } catch { /* ignore */ }
    });

    it('expands ~/ prefix against the user home dir', async () => {
      configureProfilePath('~/.__artibot_test_home_expansion.json');
      const expected = join(homedir(), '.__artibot_test_home_expansion.json');
      await recordSignal({ type: 'slash-command', value: 'home-expand' });
      expect(existsSync(expected)).toBe(true);
      try { rmSync(expected); } catch { /* ignore */ }
    });
  });

  // The benchmark runner sandboxes a measured child by moving HOME/USERPROFILE
  // (scripts/bench/hook-latency.mjs#hookEnv). That alone does NOT move this
  // store: artibot.config.json's `ux.profilePath` is plugin-root-relative, so
  // `configureProfilePath()` re-roots it under the real checkout and the child
  // writes into the developer's live profile. Measured 2026-09-11: one
  // `--slot all --n 3 --warmup 1` run added 5 signals to the real
  // `runtime/user-profile.json`, every one of them the bench's own fixture
  // prompt. `ARTIBOT_USER_PROFILE_PATH` is the redirect that closes that hole.
  //
  // It is deliberately checked BEFORE the `cachedProfilePath` branch: the hook
  // calls `configureProfilePath(config.ux.profilePath)` on every prompt, so an
  // override consulted after the cache would always lose.
  describe('resolveProfilePath() ARTIBOT_USER_PROFILE_PATH override', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns the env path, outranking a configured path', () => {
      const envTarget = uniquePath();
      // The outer beforeEach already called configureProfilePath(profilePath),
      // so this asserts the override beats a populated cache, not just an
      // empty one.
      expect(resolveProfilePath()).toBe(profilePath);
      vi.stubEnv('ARTIBOT_USER_PROFILE_PATH', envTarget);
      expect(resolveProfilePath()).toBe(resolve(envTarget));
    });

    it('resolves a relative env path against CWD, not the plugin root', () => {
      vi.stubEnv('ARTIBOT_USER_PROFILE_PATH', 'sandbox-profile.json');
      expect(resolveProfilePath()).toBe(resolve('sandbox-profile.json'));
    });

    it('falls back to <state dir>/runtime/user-profile.json when unset and unconfigured', () => {
      _resetPathCache();
      // The SAME file the shipped config value `ux.profilePath: runtime/user-profile.json`
      // resolves to, so a reader that never configured a path (self-benchmark) sees what the
      // hook wrote. It used to be ~/.claude/artibot/user-profile.json, a different file
      // from the one the hook wrote.
      expect(resolveProfilePath())
        .toBe(join(resolveArtibotDir(), 'runtime', 'user-profile.json'));
      configureProfilePath('runtime/user-profile.json');
      expect(resolveProfilePath())
        .toBe(join(resolveArtibotDir(), 'runtime', 'user-profile.json'));
    });

    it('with a real home and no override the default is under <home>/.claude/artibot/runtime', () => {
      _resetPathCache();
      const saved = {
        ARTIBOT_STATE_DIR: process.env.ARTIBOT_STATE_DIR,
        ARTIBOT_STATE_DIR_HOME: process.env.ARTIBOT_STATE_DIR_HOME,
      };
      try {
        delete process.env.ARTIBOT_STATE_DIR;
        delete process.env.ARTIBOT_STATE_DIR_HOME;
        expect(resolveProfilePath())
          .toBe(join(getHomeDir(), '.claude', 'artibot', 'runtime', 'user-profile.json'));
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it('treats an empty string as unset', () => {
      vi.stubEnv('ARTIBOT_USER_PROFILE_PATH', '');
      // Must not become `resolve('')` (= CWD), which would silently point the
      // profile at a directory and make every write fail.
      expect(resolveProfilePath()).toBe(profilePath);
    });

    it('treats a whitespace-only string as unset', () => {
      // A shell that exports the var with an empty-looking value (`export
      // ARTIBOT_USER_PROFILE_PATH=" "`) is not falsy, so the empty-string
      // guard above does not catch it. Untrimmed, `resolve('  ')` is CWD —
      // the same silent-directory failure, reached by a different route.
      vi.stubEnv('ARTIBOT_USER_PROFILE_PATH', '  ');
      expect(resolveProfilePath()).toBe(profilePath);
    });
  });

  describe('tmp file hygiene', () => {
    it('does not leave a *.tmp.* file on successful write', async () => {
      await recordSignal({ type: 'slash-command', value: 'ok' });
      const dir = TMP_ROOT;
      const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp.'));
      expect(leftovers).toEqual([]);
    });

    it('cleans up stale tmp files from prior interrupted writes', async () => {
      const stale = `${profilePath}.tmp.999999`;
      writeFileSync(stale, '{"partial":true}');
      expect(existsSync(stale)).toBe(true);
      // A successful write should opportunistically clear stale tmp files.
      await recordSignal({ type: 'slash-command', value: 'trigger-cleanup' });
      expect(existsSync(stale)).toBe(false);
    });

    it('removes its own tmp file when rename fails', async () => {
      // Force a rename failure by pointing the profile at an unwritable target
      // (a path whose parent is an existing file, not a directory). On rename
      // failure writeProfile MUST unlink the tmp file and swallow the error.
      const unwritableParent = fileURLToPath(import.meta.url); // this test file
      const badTarget = join(unwritableParent, 'nope.json');
      const tmpForBad = `${badTarget}.tmp.${process.pid}`;
      configureProfilePath(badTarget);
      await recordSignal({ type: 'slash-command', value: 'force-fail' });
      expect(existsSync(tmpForBad)).toBe(false);
    });
  });

  describe('corruption resilience', () => {
    it('returns default profile when file contains invalid JSON', async () => {
      writeFileSync(profilePath, '{not json');
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
    });
  });
});

// O2 — the profile is GLOBAL and lives under the artibot state dir, and a profile the
// previous plugin build left at an old place is carried over once.
//
// Measured 2026-09-30: three cache version dirs each held their own `user-profile.json`
// (8,959 / 1,054 / 2,550 bytes, growing with every prompt) because `ux.profilePath` is
// plugin-root-relative, while `~/.claude/artibot/user-profile.json` — the documented
// default — was a different, stale file (651 bytes, last written 2026-07-31).
describe('user-profile — location and migration (O2)', () => {
  const REL = 'runtime/user-profile.json';
  let base;
  let stateDir;
  let restoreState;
  let savedPluginRoot;
  let savedProfileEnv;

  /** A profile with `n` slash-command signals — `insufficient signals (n/10)` when read. */
  const profileWith = (n) => JSON.stringify({
    skillLevel: 'novice',
    source: 'initial',
    signals: Array.from({ length: n }, (_, i) => ({ type: 'slash-command', value: `plan ${i}`, timestamp: i })),
    evidence: [],
    updatedAt: new Date(0).toISOString(),
  });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'artibot-profile-o2-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
    restoreState = pointStateDirAt(stateDir);
    savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    savedProfileEnv = process.env.ARTIBOT_USER_PROFILE_PATH;
    delete process.env.ARTIBOT_USER_PROFILE_PATH;
    _resetPathCache();
  });

  afterEach(() => {
    _resetPathCache();
    restoreState();
    if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
    if (savedProfileEnv === undefined) delete process.env.ARTIBOT_USER_PROFILE_PATH;
    else process.env.ARTIBOT_USER_PROFILE_PATH = savedProfileEnv;
    rmSync(base, { recursive: true, force: true });
  });

  function seed(file, content) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  it('the hook\'s config value and the no-config default are one file (a reader sees what the hook wrote)', async () => {
    configureProfilePath(REL); // what runtime-prompt.js does from config.ux.profilePath
    await recordSignal({ type: 'slash-command', value: 'plan' });
    const written = resolveProfilePath();
    expect(written).toBe(join(stateDir, 'runtime', 'user-profile.json'));
    expect(existsSync(written)).toBe(true);

    _resetPathCache(); // a reader process that never configured a path
    expect(resolveProfilePath()).toBe(written);
  });

  it('carries over a profile the previous version left in a SIBLING version directory', async () => {
    const cache = join(base, 'cache', 'artibot', 'artibot');
    const running = join(cache, '4.71.0');
    mkdirSync(running, { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = running;
    seed(join(cache, '4.70.0', REL), profileWith(8));

    configureProfilePath(REL);
    const p = await getProfile();

    expect(p.evidence.join(' ')).toMatch(/\(8\/10\)/);
    expect(existsSync(join(stateDir, 'runtime', 'user-profile.json'))).toBe(true);
  });

  it('carries over the profile in the running plugin root\'s own runtime/', async () => {
    const pluginRoot = join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    seed(join(pluginRoot, REL), profileWith(5));

    const p = await getProfile(); // no configureProfilePath: the default path migrates too

    expect(p.evidence.join(' ')).toMatch(/\(5\/10\)/);
  });

  it('carries over the OLD DEFAULT, <state dir>/user-profile.json, after the plugin-root copies', async () => {
    const pluginRoot = join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    seed(join(stateDir, 'user-profile.json'), profileWith(3));

    const p = await getProfile();

    expect(p.evidence.join(' ')).toMatch(/\(3\/10\)/);
    expect(existsSync(join(stateDir, 'runtime', 'user-profile.json'))).toBe(true);
  });

  it('never overwrites a profile that is already at the new location', async () => {
    const pluginRoot = join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    seed(join(pluginRoot, REL), profileWith(8));
    seed(join(stateDir, 'runtime', 'user-profile.json'), profileWith(2));

    const p = await getProfile();

    expect(p.evidence.join(' ')).toMatch(/\(2\/10\)/);
    expect(JSON.parse(readFileSync(join(stateDir, 'runtime', 'user-profile.json'), 'utf8')).signals).toHaveLength(2);
  });

  it('an absolute configured path is the operator\'s choice: no migration into it', async () => {
    const pluginRoot = join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    seed(join(pluginRoot, REL), profileWith(8));
    const explicit = join(base, 'mine', 'profile.json');

    configureProfilePath(explicit);
    const p = await getProfile();

    expect(p.evidence.join(' ')).toMatch(/\(0\/10\)/);
    expect(existsSync(explicit)).toBe(false);
  });

  it('an ARTIBOT_USER_PROFILE_PATH override is never migrated into either', async () => {
    const pluginRoot = join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    seed(join(pluginRoot, REL), profileWith(8));
    const sandboxed = join(base, 'sandbox', 'profile.json');
    process.env.ARTIBOT_USER_PROFILE_PATH = sandboxed;

    const p = await getProfile();

    expect(p.evidence.join(' ')).toMatch(/\(0\/10\)/);
    expect(existsSync(sandboxed)).toBe(false);
  });
});
