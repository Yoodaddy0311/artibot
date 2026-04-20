import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  _resetPathCache,
  configureProfilePath,
  detectSkillLevel,
  getProfile,
  recordSignal,
  setSkillLevel,
} from '../../lib/core/user-profile.js';

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
