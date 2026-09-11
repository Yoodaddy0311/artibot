import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync,
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
import { getHomeDir, getPluginRoot } from '../../lib/core/platform.js';
import {
  readDecisionEvents,
  recordSkillLevelChanged,
  resetDecisionRecorderStats,
  SKILL_LEVEL_CHANGED,
} from '../../lib/observability/decision-events.js';

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

    it('resolves relative paths against the plugin root (not CWD)', async () => {
      // Write to a relative path — the module must anchor it to the plugin
      // root so it resolves to the same file regardless of process.cwd().
      const relPath = `runtime/__test__/user-profile-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      const expected = join(getPluginRoot(), relPath);
      configureProfilePath(relPath);
      await recordSignal({ type: 'slash-command', value: 'test' });
      expect(existsSync(expected)).toBe(true);
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

    it('falls back to the default home path when unset and unconfigured', () => {
      _resetPathCache();
      expect(resolveProfilePath())
        .toBe(join(getHomeDir(), '.claude', 'artibot', 'user-profile.json'));
    });

    it('treats an empty string as unset', () => {
      vi.stubEnv('ARTIBOT_USER_PROFILE_PATH', '');
      // Must not become `resolve('')` (= CWD), which would silently point the
      // profile at a directory and make every write fail.
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
      const { writeFileSync } = await import('node:fs');
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
      const { writeFileSync } = await import('node:fs');
      writeFileSync(profilePath, '{not json');
      const p = await getProfile();
      expect(p.skillLevel).toBe('novice');
    });
  });
});
