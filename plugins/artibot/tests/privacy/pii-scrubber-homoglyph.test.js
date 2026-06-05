import { beforeEach, describe, expect, it } from 'vitest';
import {
  getScrubStats,
  resetStats,
  scrub,
  scrubPattern,
} from '../../lib/privacy/pii-scrubber.js';

// Homoglyph characters used to disguise PII (Cyrillic lookalikes for Latin).
// Aliased to named constants so each spoofed literal below reads clearly.
const CYR_A = 'а'; // Cyrillic 'а' (U+0430) — looks like Latin 'a'
const CYR_E = 'е'; // Cyrillic 'е' (U+0435) — looks like Latin 'e'
const CYRILLIC = /[Ѐ-ӿ]/; // any Cyrillic residue

describe('WIRE-16 homoglyph normalization in scrub()', () => {
  beforeEach(() => resetStats());

  it('catches PII whose local-part starts with a Cyrillic homoglyph (discriminating)', () => {
    // UNWIRED: the email regex matches from 'dmin@corp.io', so the leading
    // Cyrillic а leaks -> 'mail а[EMAIL] now'. WIRED: а is normalized to Latin
    // 'a' first, so the whole address is masked. The toBe() assertion below
    // therefore FAILS on unwired code (proves the wiring does work).
    const spoofed = `mail ${CYR_A}dmin@corp.io now`;
    const out = scrub(spoofed);
    expect(out).toBe('mail [EMAIL] now');
    expect(out).not.toMatch(CYRILLIC);
  });

  it('records a homoglyph-normalization stat when it fires', () => {
    scrub(`p${CYR_A}ypal user@example.com`); // mixed-script (Cyrillic а)
    expect(getScrubStats().homoglyphNormalized).toBe(1);
  });

  it('keeps the homoglyph signal out of byCategory (no PII-category pollution)', () => {
    scrub(`${CYR_E}xample user@example.com`);
    // normalization fired, but byCategory must only carry real PII categories.
    expect(getScrubStats().byCategory.homoglyph).toBeUndefined();
    expect(getScrubStats().homoglyphNormalized).toBe(1);
  });

  it('leaves clean pure-Latin text untouched (no false trigger)', () => {
    const clean = 'plain ascii text only';
    expect(scrub(clean)).toBe(clean);
    expect(getScrubStats().homoglyphNormalized).toBe(0);
  });

  it('does not corrupt non-Latin-only text (no Latin present)', () => {
    const russian = 'русский'; // 'русский', no Latin
    expect(scrub(russian)).toBe(russian);
    expect(getScrubStats().homoglyphNormalized).toBe(0);
  });

  it('normalization flows through scrubPattern recursion (discriminating)', () => {
    // 'emаil' carries a Cyrillic а; unwired leaves it as residue beside the
    // masked address. Wiring normalizes the whole string first.
    const r = scrubPattern({ note: `em${CYR_A}il a@b.com` });
    expect(r.note).toContain('[EMAIL]');
    expect(r.note).not.toMatch(CYRILLIC);
  });
});
