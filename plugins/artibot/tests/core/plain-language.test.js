import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDictionaries,
  getDictionary,
  registerDictionary,
  toPlainLanguage,
} from '../../lib/core/plain-language.js';

describe('plain-language', () => {
  beforeEach(() => {
    _resetDictionaries();
  });

  describe('toPlainLanguage()', () => {
    it('translates ko dictionary terms for novice users', () => {
      const input = 'build failed: 0 errors but tests passing';
      const out = toPlainLanguage(input, { locale: 'ko', skillLevel: 'novice' });
      expect(out).toContain('\uBE4C\uB4DC \uACFC\uC815\uC5D0 \uBB38\uC81C\uAC00 \uC0DD\uACBC\uC5B4\uC694');
      expect(out).toContain('\uAE68\uB057\uD574\uC694');
      expect(out).toContain('\uD14C\uC2A4\uD2B8\uAC00 \uBAA8\uB450 \uD1B5\uACFC\uD588\uC5B4\uC694');
    });

    it('returns original text when skillLevel=pro', () => {
      const input = 'build failed: module not found';
      const out = toPlainLanguage(input, { locale: 'ko', skillLevel: 'pro' });
      expect(out).toBe(input);
    });

    it('is case-insensitive', () => {
      const out = toPlainLanguage('BUILD FAILED', { locale: 'ko', skillLevel: 'novice' });
      expect(out).toBe('\uBE4C\uB4DC \uACFC\uC815\uC5D0 \uBB38\uC81C\uAC00 \uC0DD\uACBC\uC5B4\uC694');
    });

    it('respects word boundaries for ascii phrases', () => {
      // "conflict" should not replace "conflicting"
      const input = 'conflicting changes';
      const out = toPlainLanguage(input, { locale: 'ko', skillLevel: 'novice' });
      expect(out).toBe('conflicting changes');
    });

    it('replaces standalone word "conflict"', () => {
      const out = toPlainLanguage('merge conflict detected', { locale: 'ko', skillLevel: 'novice' });
      expect(out).toContain('\uB3D9\uC2DC\uC5D0 \uBC14\uB01C \uACF3\uC774 \uACB9\uCB65\uC5B4\uC694');
    });

    it('returns non-string input unchanged', () => {
      expect(toPlainLanguage(null, { skillLevel: 'novice' })).toBeNull();
      expect(toPlainLanguage(undefined, { skillLevel: 'novice' })).toBeUndefined();
      expect(toPlainLanguage(42, { skillLevel: 'novice' })).toBe(42);
    });

    it('prefers longer phrases over shorter substrings', () => {
      // "permission denied" should win over a hypothetical "denied" entry
      registerDictionary('ko', { 'denied': 'X' });
      const out = toPlainLanguage('permission denied', { locale: 'ko', skillLevel: 'novice' });
      expect(out).toContain('\uAD8C\uD55C\uC774 \uC5C6\uC5B4\uC11C \uB9C9\uD614\uC5B4\uC694');
      expect(out).not.toContain('X');
    });

    it('defaults locale to ko and skillLevel to novice', () => {
      const out = toPlainLanguage('0 errors');
      expect(out).toBe('\uAE68\uB057\uD574\uC694');
    });

    it('returns original when locale is unknown', () => {
      const out = toPlainLanguage('build failed', { locale: 'fr', skillLevel: 'novice' });
      expect(out).toBe('build failed');
    });
  });

  describe('getDictionary()', () => {
    it('returns a snapshot for a specific locale', () => {
      const dict = getDictionary('ko');
      expect(dict['0 errors']).toBeDefined();
      expect(dict['build failed']).toBeDefined();
    });

    it('returns empty object for unknown locale', () => {
      expect(getDictionary('fr')).toEqual({});
    });

    it('returns all dictionaries when locale is omitted', () => {
      const all = getDictionary();
      expect(all.ko).toBeDefined();
      expect(all.en).toBeDefined();
      expect(all.ja).toBeDefined();
    });

    it('returned snapshot is not the internal map reference', () => {
      const a = getDictionary('ko');
      const b = getDictionary('ko');
      expect(a).not.toBe(b);
      a['0 errors'] = 'mutated';
      // original internal dict remains untouched on next fetch
      expect(getDictionary('ko')['0 errors']).not.toBe('mutated');
    });
  });

  describe('registerDictionary()', () => {
    it('merges user-provided entries into an existing locale', () => {
      registerDictionary('ko', { 'OOM': '\uBA54\uBAA8\uB9AC \uBD80\uC871' });
      const dict = getDictionary('ko');
      expect(dict.OOM).toBe('\uBA54\uBAA8\uB9AC \uBD80\uC871');
      // pre-existing entries still present
      expect(dict['0 errors']).toBeDefined();
    });

    it('creates a new locale bucket when missing', () => {
      registerDictionary('fr', { 'build failed': 'la construction a \u00E9chou\u00E9' });
      const out = toPlainLanguage('build failed', { locale: 'fr', skillLevel: 'novice' });
      expect(out).toBe('la construction a \u00E9chou\u00E9');
    });

    it('ignores invalid entry types silently', () => {
      const before = getDictionary('ko');
      registerDictionary('ko', { 'good': 'ok', 'bad': 123 });
      const after = getDictionary('ko');
      expect(after.good).toBe('ok');
      expect(after.bad).toBeUndefined();
      expect(Object.keys(after).length).toBeGreaterThanOrEqual(Object.keys(before).length);
    });

    it('returns the resulting snapshot', () => {
      const snap = registerDictionary('ko', { 'foo': 'bar' });
      expect(snap.foo).toBe('bar');
    });

    it('returns all dictionaries when locale is empty string', () => {
      const result = registerDictionary('', { a: 'b' });
      // empty-string locale is treated as "no locale" -> full snapshot
      expect(result.ko).toBeDefined();
      expect(result.en).toBeDefined();
      expect(result.ja).toBeDefined();
      // no locale was actually registered for the empty key
      expect(result['']).toBeUndefined();
    });

    it('ignores null entries argument', () => {
      const before = getDictionary('ko');
      registerDictionary('ko', null);
      const after = getDictionary('ko');
      expect(Object.keys(after)).toEqual(Object.keys(before));
    });
  });

  describe('immutability', () => {
    it('does not alter input string when translating', () => {
      const input = 'build failed again';
      toPlainLanguage(input, { skillLevel: 'novice' });
      expect(input).toBe('build failed again');
    });

    it('returns distinct string instances on repeat calls', () => {
      const input = 'build failed';
      const a = toPlainLanguage(input, { skillLevel: 'novice' });
      const b = toPlainLanguage(input, { skillLevel: 'novice' });
      expect(a).toEqual(b);
    });
  });
});
