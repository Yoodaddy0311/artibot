/**
 * Native Effort Signal Reader (PRODUCER half of TODO #30806).
 *
 * Covers the three contract paths required by #30806:
 *   (a) a recognized native env var → that band is read,
 *   (b) no env var → null (heuristic fallback, regression-zero),
 *   (c) empty / unrecognized value → null (heuristic fallback),
 * plus the router-side `syncNativeEffortFromEnv` producer wiring and its
 * effect on `classifyComplexity` (native override vs pure-heuristic).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getNativeEffortSource,
  NATIVE_EFFORT_ENV_VARS,
  normalizeEffortLevel,
  readNativeEffortFromPayload,
  readNativeEffortLevel,
  resolveNativeEffort,
} from '../../lib/cognitive/native-effort.js';
import {
  classifyComplexity,
  getNativeEffortHint,
  resetRouter,
  syncNativeEffortFromEnv,
} from '../../lib/cognitive/router.js';

describe('native-effort reader (PRODUCER #30806)', () => {
  describe('normalizeEffortLevel()', () => {
    it('maps canonical levels verbatim', () => {
      expect(normalizeEffortLevel('max')).toBe('max');
      expect(normalizeEffortLevel('xhigh')).toBe('xhigh');
      expect(normalizeEffortLevel('high')).toBe('high');
      expect(normalizeEffortLevel('medium')).toBe('medium');
      expect(normalizeEffortLevel('low')).toBe('low');
    });

    it('is case- and whitespace-insensitive', () => {
      expect(normalizeEffortLevel('  HIGH  ')).toBe('high');
      expect(normalizeEffortLevel('Low')).toBe('low');
    });

    it('accepts common aliases', () => {
      expect(normalizeEffortLevel('x-high')).toBe('xhigh');
      expect(normalizeEffortLevel('very-high')).toBe('xhigh');
      expect(normalizeEffortLevel('med')).toBe('medium');
      expect(normalizeEffortLevel('maximum')).toBe('max');
      expect(normalizeEffortLevel('minimum')).toBe('low');
    });

    it('returns null for unrecognized / empty / non-string', () => {
      expect(normalizeEffortLevel('turbo')).toBeNull();
      expect(normalizeEffortLevel('')).toBeNull();
      expect(normalizeEffortLevel('   ')).toBeNull();
      expect(normalizeEffortLevel(undefined)).toBeNull();
      expect(normalizeEffortLevel(42)).toBeNull();
      expect(normalizeEffortLevel(null)).toBeNull();
    });
  });

  describe('readNativeEffortLevel()', () => {
    it('(a) reads the official CLAUDE_EFFORT env var', () => {
      const env = { CLAUDE_EFFORT: 'xhigh' };
      expect(readNativeEffortLevel(env)).toBe('xhigh');
    });

    it('(b) returns null when no env var is set → heuristic fallback', () => {
      expect(readNativeEffortLevel({})).toBeNull();
    });

    it('(c) returns null for an empty value → heuristic fallback', () => {
      expect(readNativeEffortLevel({ CLAUDE_EFFORT: '' })).toBeNull();
    });

    it('(c) returns null for an unrecognized value → heuristic fallback', () => {
      expect(readNativeEffortLevel({ CLAUDE_EFFORT: 'banana' })).toBeNull();
    });

    it('official CLAUDE_EFFORT outranks an unofficial fallback var', () => {
      const env = {
        CLAUDE_CODE_EFFORT: 'low',   // unofficial fallback
        CLAUDE_EFFORT: 'high',       // OFFICIAL — first in the list
      };
      expect(readNativeEffortLevel(env)).toBe('high');
    });

    it('falls back to an unofficial var only when CLAUDE_EFFORT is unset/invalid', () => {
      const env = {
        CLAUDE_EFFORT: 'nonsense',
        CLAUDE_CODE_EFFORT: 'medium',
      };
      expect(readNativeEffortLevel(env)).toBe('medium');
    });

    it('handles a missing/invalid env object safely', () => {
      // null short-circuits the guard; 42 is a non-object primitive. Both yield
      // null without touching process.env. (undefined would trigger the
      // `env = process.env` default, so it is intentionally not asserted here.)
      expect(readNativeEffortLevel(null)).toBeNull();
      expect(readNativeEffortLevel(42)).toBeNull();
    });

    it('every candidate var name resolves a value placed under it', () => {
      for (const name of NATIVE_EFFORT_ENV_VARS) {
        expect(readNativeEffortLevel({ [name]: 'high' })).toBe('high');
      }
    });
  });

  describe('readNativeEffortFromPayload() — stdin effort.level (tool-use hooks)', () => {
    it('reads the official { effort: { level } } shape', () => {
      expect(readNativeEffortFromPayload({ effort: { level: 'high' } })).toBe('high');
      expect(readNativeEffortFromPayload({ effort: { level: 'MAX' } })).toBe('max');
    });

    it('returns null when the field is absent / empty / unrecognized', () => {
      expect(readNativeEffortFromPayload({})).toBeNull();
      expect(readNativeEffortFromPayload({ effort: {} })).toBeNull();
      expect(readNativeEffortFromPayload({ effort: { level: '' } })).toBeNull();
      expect(readNativeEffortFromPayload({ effort: { level: 'turbo' } })).toBeNull();
    });

    it('handles a missing/invalid payload safely', () => {
      expect(readNativeEffortFromPayload(null)).toBeNull();
      expect(readNativeEffortFromPayload(undefined)).toBeNull();
      expect(readNativeEffortFromPayload('nope')).toBeNull();
    });
  });

  describe('resolveNativeEffort() — precedence: stdin > env > heuristic', () => {
    it('stdin effort.level outranks the env var', () => {
      const out = resolveNativeEffort({
        payload: { effort: { level: 'low' } },
        env: { CLAUDE_EFFORT: 'high' },
      });
      expect(out).toBe('low');
    });

    it('falls back to env var when stdin field is absent', () => {
      const out = resolveNativeEffort({
        payload: { event: 'UserPromptSubmit' }, // no effort field (non-tool-use)
        env: { CLAUDE_EFFORT: 'xhigh' },
      });
      expect(out).toBe('xhigh');
    });

    it('falls back to env var when stdin field is unrecognized', () => {
      const out = resolveNativeEffort({
        payload: { effort: { level: 'bogus' } },
        env: { CLAUDE_EFFORT: 'medium' },
      });
      expect(out).toBe('medium');
    });

    it('returns null when BOTH sources are absent → heuristic (regression-0)', () => {
      // Explicit empty env so the assertion does not depend on the ambient
      // process.env (a live Claude Code session may export $CLAUDE_EFFORT).
      expect(resolveNativeEffort({ payload: {}, env: {} })).toBeNull();
      expect(resolveNativeEffort({ env: {} })).toBeNull();
      expect(resolveNativeEffort({ payload: { event: 'X' }, env: {} })).toBeNull();
    });
  });

  describe('getNativeEffortSource()', () => {
    it('reports the stdin source when effort.level is present (highest precedence)', () => {
      expect(getNativeEffortSource({
        payload: { effort: { level: 'high' } },
        env: { CLAUDE_EFFORT: 'low' },
      })).toBe('stdin:effort.level');
    });
    it('reports the env var name when only the env supplies it', () => {
      expect(getNativeEffortSource({ env: { CLAUDE_EFFORT: 'low' } })).toBe('CLAUDE_EFFORT');
    });
    it('returns null when nothing valid is set', () => {
      expect(getNativeEffortSource({ env: { CLAUDE_EFFORT: 'xxx' } })).toBeNull();
      expect(getNativeEffortSource({ payload: {}, env: {} })).toBeNull();
    });
  });
});

describe('router.syncNativeEffortFromEnv() producer wiring (#30806)', () => {
  beforeEach(() => resetRouter());
  afterEach(() => resetRouter());

  it('(a) installs the hint from a native env var', () => {
    const applied = syncNativeEffortFromEnv({ CLAUDE_EFFORT: 'low' });
    expect(applied).toBe('low');
    expect(getNativeEffortHint()).toEqual({ effortLevel: 'low', band: 'low' });
  });

  it('maps max/xhigh/high bands to the consumer high level', () => {
    expect(syncNativeEffortFromEnv({ CLAUDE_EFFORT: 'max' })).toBe('high');
    expect(getNativeEffortHint().band).toBe('max');
    resetRouter();
    expect(syncNativeEffortFromEnv({ CLAUDE_EFFORT: 'xhigh' })).toBe('high');
    resetRouter();
    expect(syncNativeEffortFromEnv({ CLAUDE_EFFORT: 'high' })).toBe('high');
  });

  it('(b) clears the hint to null when no native env var is present', () => {
    syncNativeEffortFromEnv({ CLAUDE_EFFORT: 'low' });
    expect(getNativeEffortHint()).not.toBeNull();
    const applied = syncNativeEffortFromEnv({});
    expect(applied).toBeNull();
    expect(getNativeEffortHint()).toBeNull();
  });

  it('(c) clears the hint for an unrecognized value', () => {
    syncNativeEffortFromEnv({ CLAUDE_EFFORT: 'high' });
    expect(syncNativeEffortFromEnv({ CLAUDE_EFFORT: 'bogus' })).toBeNull();
    expect(getNativeEffortHint()).toBeNull();
  });
});

describe('native override vs heuristic in classifyComplexity (#30806)', () => {
  beforeEach(() => resetRouter());
  afterEach(() => resetRouter());

  it('low native band forces System 1 even on complex input', () => {
    const complex =
      'security audit: migrate the production database, deploy to kubernetes, and fix the authentication vulnerability';
    // Sanity: without a native signal this routes to System 2.
    expect(classifyComplexity(complex).system).toBe(2);
    // With a low native band installed, it is forced to System 1.
    syncNativeEffortFromEnv({ CLAUDE_EFFORT: 'low' });
    const out = classifyComplexity(complex);
    expect(out.system).toBe(1);
    expect(out.nativeEffort).toBe('low');
  });

  it('high native band forces System 2 even on trivial input', () => {
    expect(classifyComplexity('fix a typo').system).toBe(1);
    syncNativeEffortFromEnv({ CLAUDE_EFFORT: 'xhigh' }); // → high
    const out = classifyComplexity('fix a typo');
    expect(out.system).toBe(2);
    expect(out.nativeEffort).toBe('high');
  });

  it('(b) regression-zero: no native env var leaves classification identical', () => {
    // Baseline with a clean router (no native signal anywhere).
    const baseline = classifyComplexity('implement login feature with oauth');
    // Producer run with an EMPTY env must not install any hint…
    syncNativeEffortFromEnv({});
    const afterNoSignal = classifyComplexity('implement login feature with oauth');
    expect(afterNoSignal.system).toBe(baseline.system);
    expect(afterNoSignal.score).toBe(baseline.score);
    expect(afterNoSignal.nativeEffort).toBeNull();
  });
});
