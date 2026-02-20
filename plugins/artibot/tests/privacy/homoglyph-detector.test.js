import { describe, it, expect } from 'vitest';
import {
  detectHomoglyphs,
  checkMixedScript,
  normalizeHomoglyphs,
  getHomoglyphMap,
} from '../../lib/privacy/homoglyph-detector.js';

// ---------------------------------------------------------------------------
// detectHomoglyphs()
// ---------------------------------------------------------------------------
describe('detectHomoglyphs()', () => {
  it('detects Cyrillic "a" (U+0430) in Latin text', () => {
    const input = 'p\u0430ypal.com'; // Cyrillic а
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      index: 1,
      char: '\u0430',
      latin: 'a',
      script: 'Cyrillic',
      codePoint: 0x0430,
    });
  });

  it('detects Cyrillic "e" (U+0435) in Latin text', () => {
    const input = 'us\u0435r'; // Cyrillic е
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].latin).toBe('e');
    expect(findings[0].script).toBe('Cyrillic');
  });

  it('detects Cyrillic "o" (U+043E) in Latin text', () => {
    const input = 'g\u043E\u043Egle.com'; // two Cyrillic о
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(2);
    expect(findings[0].latin).toBe('o');
    expect(findings[1].latin).toBe('o');
  });

  it('detects Cyrillic "p" (U+0440) in Latin text', () => {
    const input = '\u0440aypal'; // Cyrillic р
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].latin).toBe('p');
  });

  it('detects Cyrillic "c" (U+0441) in Latin text', () => {
    const input = 'se\u0441ure'; // Cyrillic с
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].latin).toBe('c');
  });

  it('detects Greek "o" (U+03BF) in Latin text', () => {
    const input = 'g\u03BFogle'; // Greek ο mixed with Latin o
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].script).toBe('Greek');
    expect(findings[0].latin).toBe('o');
  });

  it('detects Greek uppercase "O" (U+039F) in Latin text', () => {
    const input = '\u039FK'; // Greek Ο + Latin K
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].latin).toBe('O');
    expect(findings[0].script).toBe('Greek');
  });

  it('detects multiple homoglyphs from different scripts', () => {
    // Mix of Cyrillic а and Greek ο
    const input = '\u0430pple.c\u03BFm';
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(2);
    expect(findings[0].script).toBe('Cyrillic');
    expect(findings[1].script).toBe('Greek');
  });

  it('returns empty array for clean Latin text', () => {
    expect(detectHomoglyphs('paypal.com')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(detectHomoglyphs('')).toEqual([]);
  });

  it('returns empty array for null input', () => {
    expect(detectHomoglyphs(null)).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(detectHomoglyphs(undefined)).toEqual([]);
  });

  it('returns empty array for non-string input', () => {
    expect(detectHomoglyphs(42)).toEqual([]);
  });

  it('detects uppercase Cyrillic lookalikes', () => {
    const input = '\u0410\u0412\u0415'; // Cyrillic А В Е
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(3);
    expect(findings[0].latin).toBe('A');
    expect(findings[1].latin).toBe('B');
    expect(findings[2].latin).toBe('E');
  });

  it('reports correct index positions', () => {
    const input = 'abc\u0430def\u0435'; // positions 3 and 7
    const findings = detectHomoglyphs(input);
    expect(findings[0].index).toBe(3);
    expect(findings[1].index).toBe(7);
  });

  it('detects Cyrillic x (U+0445) lookalike', () => {
    const input = 'te\u0445t'; // Cyrillic х
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].latin).toBe('x');
  });

  it('detects Greek rho (U+03C1) as p lookalike', () => {
    const input = '\u03C1aypal'; // Greek ρ
    const findings = detectHomoglyphs(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].latin).toBe('p');
    expect(findings[0].script).toBe('Greek');
  });
});

// ---------------------------------------------------------------------------
// checkMixedScript()
// ---------------------------------------------------------------------------
describe('checkMixedScript()', () => {
  it('detects mixed Cyrillic + Latin script', () => {
    const result = checkMixedScript('\u0430pple.com'); // Cyrillic а + Latin
    expect(result.mixed).toBe(true);
    expect(result.scripts).toContain('Latin');
    expect(result.scripts).toContain('Cyrillic');
  });

  it('detects mixed Greek + Latin script', () => {
    const result = checkMixedScript('g\u03BFogle'); // Greek ο + Latin
    expect(result.mixed).toBe(true);
    expect(result.scripts).toContain('Latin');
    expect(result.scripts).toContain('Greek');
  });

  it('returns mixed:false for pure Latin text', () => {
    const result = checkMixedScript('paypal.com');
    expect(result.mixed).toBe(false);
    expect(result.scripts).toEqual(['Latin']);
  });

  it('returns mixed:false for pure Cyrillic text (no Latin)', () => {
    const result = checkMixedScript('\u0430\u0435\u043E'); // All Cyrillic, no Latin
    expect(result.mixed).toBe(false);
  });

  it('returns sorted scripts array', () => {
    const result = checkMixedScript('\u0430b\u03BFd'); // Cyrillic + Latin + Greek
    expect(result.scripts).toEqual(['Cyrillic', 'Greek', 'Latin']);
  });

  it('includes findings in result', () => {
    const result = checkMixedScript('p\u0430y');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].char).toBe('\u0430');
  });

  it('handles null input', () => {
    const result = checkMixedScript(null);
    expect(result.mixed).toBe(false);
    expect(result.scripts).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('handles empty string', () => {
    const result = checkMixedScript('');
    expect(result.mixed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeHomoglyphs()
// ---------------------------------------------------------------------------
describe('normalizeHomoglyphs()', () => {
  it('replaces Cyrillic "a" with Latin "a"', () => {
    expect(normalizeHomoglyphs('p\u0430ypal')).toBe('paypal');
  });

  it('replaces multiple Cyrillic characters', () => {
    // Cyrillic а, е, о
    expect(normalizeHomoglyphs('\u0430\u0435\u043E')).toBe('aeo');
  });

  it('replaces Greek characters with Latin equivalents', () => {
    expect(normalizeHomoglyphs('\u03BFk')).toBe('ok');
  });

  it('preserves pure Latin text unchanged', () => {
    expect(normalizeHomoglyphs('hello world')).toBe('hello world');
  });

  it('handles mixed homoglyphs from multiple scripts', () => {
    // Cyrillic а + Greek ο in "paypal.com"
    expect(normalizeHomoglyphs('p\u0430yp\u03BFl.com')).toBe('paypol.com');
  });

  it('returns empty string for null input', () => {
    expect(normalizeHomoglyphs(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(normalizeHomoglyphs(undefined)).toBe('');
  });

  it('handles empty string', () => {
    expect(normalizeHomoglyphs('')).toBe('');
  });

  it('normalizes uppercase Cyrillic characters', () => {
    // Cyrillic А Р С -> Latin A P C
    expect(normalizeHomoglyphs('\u0410\u0420\u0421')).toBe('APC');
  });
});

// ---------------------------------------------------------------------------
// getHomoglyphMap()
// ---------------------------------------------------------------------------
describe('getHomoglyphMap()', () => {
  it('returns an array of mappings', () => {
    const map = getHomoglyphMap();
    expect(Array.isArray(map)).toBe(true);
    expect(map.length).toBeGreaterThan(0);
  });

  it('each mapping has required properties', () => {
    const map = getHomoglyphMap();
    for (const entry of map) {
      expect(entry).toHaveProperty('char');
      expect(entry).toHaveProperty('latin');
      expect(entry).toHaveProperty('script');
      expect(entry).toHaveProperty('codePoint');
    }
  });

  it('contains Cyrillic mappings', () => {
    const map = getHomoglyphMap();
    const cyrillic = map.filter((m) => m.script === 'Cyrillic');
    expect(cyrillic.length).toBeGreaterThan(0);
  });

  it('contains Greek mappings', () => {
    const map = getHomoglyphMap();
    const greek = map.filter((m) => m.script === 'Greek');
    expect(greek.length).toBeGreaterThan(0);
  });

  it('maps Cyrillic а (U+0430) to Latin a', () => {
    const map = getHomoglyphMap();
    const entry = map.find((m) => m.codePoint === 0x0430);
    expect(entry).toBeDefined();
    expect(entry.latin).toBe('a');
    expect(entry.script).toBe('Cyrillic');
  });

  it('does not contain duplicate entries', () => {
    const map = getHomoglyphMap();
    const chars = map.map((m) => m.char);
    expect(new Set(chars).size).toBe(chars.length);
  });
});

// ---------------------------------------------------------------------------
// Real-world attack scenarios
// ---------------------------------------------------------------------------
describe('real-world attack scenarios', () => {
  it('detects IDN homograph attack on paypal.com', () => {
    // Classic phishing: replace Latin 'a' with Cyrillic 'а'
    const fake = 'p\u0430yp\u0430l.com';
    const findings = detectHomoglyphs(fake);
    expect(findings.length).toBe(2);
    expect(checkMixedScript(fake).mixed).toBe(true);
    expect(normalizeHomoglyphs(fake)).toBe('paypal.com');
  });

  it('detects mixed-script email address', () => {
    // Cyrillic е (U+0435) and Cyrillic о (U+043E)
    const email = 'us\u0435r@g\u043Email.com';
    const findings = detectHomoglyphs(email);
    expect(findings.length).toBe(2);
    // Cyrillic о maps to Latin o, so result is 'gomail' not 'gmail'
    expect(normalizeHomoglyphs(email)).toBe('user@gomail.com');
  });

  it('detects homoglyphs in URLs', () => {
    const url = 'https://g\u043E\u043Egle.com/login';
    const result = checkMixedScript(url);
    expect(result.mixed).toBe(true);
    expect(normalizeHomoglyphs(url)).toBe('https://google.com/login');
  });

  it('passes legitimate pure Latin URL', () => {
    const url = 'https://google.com/login';
    const result = checkMixedScript(url);
    expect(result.mixed).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it('detects Greek-Latin mixed domain', () => {
    const domain = '\u0391pple.com'; // Greek Α + Latin pple
    const result = checkMixedScript(domain);
    expect(result.mixed).toBe(true);
    expect(normalizeHomoglyphs(domain)).toBe('Apple.com');
  });
});
