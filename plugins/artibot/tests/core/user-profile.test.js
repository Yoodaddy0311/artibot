import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _resetPathCache,
  configureProfilePath,
  detectSkillLevel,
  getProfile,
  recordSignal,
  setSkillLevel,
} from '../../lib/core/user-profile.js';
import { getPluginRoot } from '../../lib/core/platform.js';

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
