/**
 * Unicode homoglyph detector for mixed-script attack prevention.
 * Detects visually similar characters from different Unicode scripts
 * (e.g., Cyrillic/Greek lookalikes for Latin characters) that can be
 * used for phishing, spoofing, or IDN homograph attacks.
 *
 * Zero dependencies. ESM only.
 * @module lib/privacy/homoglyph-detector
 */

// ---------------------------------------------------------------------------
// Homoglyph Mapping
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HomoglyphMapping
 * @property {string} latin - The Latin character being mimicked
 * @property {string} script - Source script name (e.g., 'Cyrillic', 'Greek')
 * @property {number} codePoint - Unicode code point of the lookalike character
 */

/**
 * Map of non-Latin code points to their Latin lookalikes.
 * Key: non-Latin character, Value: mapping metadata.
 * @type {Map<string, HomoglyphMapping>}
 */
const HOMOGLYPH_MAP = new Map([
  // Cyrillic -> Latin
  ['\u0430', { latin: 'a', script: 'Cyrillic', codePoint: 0x0430 }], // а -> a
  ['\u0435', { latin: 'e', script: 'Cyrillic', codePoint: 0x0435 }], // е -> e
  ['\u043E', { latin: 'o', script: 'Cyrillic', codePoint: 0x043E }], // о -> o
  ['\u0440', { latin: 'p', script: 'Cyrillic', codePoint: 0x0440 }], // р -> p
  ['\u0441', { latin: 'c', script: 'Cyrillic', codePoint: 0x0441 }], // с -> c
  ['\u0443', { latin: 'y', script: 'Cyrillic', codePoint: 0x0443 }], // у -> y
  ['\u0445', { latin: 'x', script: 'Cyrillic', codePoint: 0x0445 }], // х -> x
  ['\u042C', { latin: 'b', script: 'Cyrillic', codePoint: 0x042C }], // Ь -> b (uppercase soft sign)
  ['\u0410', { latin: 'A', script: 'Cyrillic', codePoint: 0x0410 }], // А -> A
  ['\u0412', { latin: 'B', script: 'Cyrillic', codePoint: 0x0412 }], // В -> B
  ['\u0415', { latin: 'E', script: 'Cyrillic', codePoint: 0x0415 }], // Е -> E
  ['\u041A', { latin: 'K', script: 'Cyrillic', codePoint: 0x041A }], // К -> K
  ['\u041C', { latin: 'M', script: 'Cyrillic', codePoint: 0x041C }], // М -> M
  ['\u041D', { latin: 'H', script: 'Cyrillic', codePoint: 0x041D }], // Н -> H
  ['\u041E', { latin: 'O', script: 'Cyrillic', codePoint: 0x041E }], // О -> O
  ['\u0420', { latin: 'P', script: 'Cyrillic', codePoint: 0x0420 }], // Р -> P
  ['\u0421', { latin: 'C', script: 'Cyrillic', codePoint: 0x0421 }], // С -> C
  ['\u0422', { latin: 'T', script: 'Cyrillic', codePoint: 0x0422 }], // Т -> T
  ['\u0425', { latin: 'X', script: 'Cyrillic', codePoint: 0x0425 }], // Х -> X

  // Greek -> Latin
  ['\u03BF', { latin: 'o', script: 'Greek', codePoint: 0x03BF }],    // ο -> o
  ['\u03B1', { latin: 'a', script: 'Greek', codePoint: 0x03B1 }],    // α -> a
  ['\u03B5', { latin: 'e', script: 'Greek', codePoint: 0x03B5 }],    // ε -> e (approximate)
  ['\u03B9', { latin: 'i', script: 'Greek', codePoint: 0x03B9 }],    // ι -> i
  ['\u03BA', { latin: 'k', script: 'Greek', codePoint: 0x03BA }],    // κ -> k
  ['\u03BD', { latin: 'v', script: 'Greek', codePoint: 0x03BD }],    // ν -> v
  ['\u03C1', { latin: 'p', script: 'Greek', codePoint: 0x03C1 }],    // ρ -> p
  ['\u03C4', { latin: 't', script: 'Greek', codePoint: 0x03C4 }],    // τ -> t (approximate)
  ['\u03C5', { latin: 'u', script: 'Greek', codePoint: 0x03C5 }],    // υ -> u
  ['\u039F', { latin: 'O', script: 'Greek', codePoint: 0x039F }],    // Ο -> O
  ['\u0391', { latin: 'A', script: 'Greek', codePoint: 0x0391 }],    // Α -> A
  ['\u0392', { latin: 'B', script: 'Greek', codePoint: 0x0392 }],    // Β -> B
  ['\u0395', { latin: 'E', script: 'Greek', codePoint: 0x0395 }],    // Ε -> E
  ['\u0397', { latin: 'H', script: 'Greek', codePoint: 0x0397 }],    // Η -> H
  ['\u0399', { latin: 'I', script: 'Greek', codePoint: 0x0399 }],    // Ι -> I
  ['\u039A', { latin: 'K', script: 'Greek', codePoint: 0x039A }],    // Κ -> K
  ['\u039C', { latin: 'M', script: 'Greek', codePoint: 0x039C }],    // Μ -> M
  ['\u039D', { latin: 'N', script: 'Greek', codePoint: 0x039D }],    // Ν -> N
  ['\u03A1', { latin: 'P', script: 'Greek', codePoint: 0x03A1 }],    // Ρ -> P
  ['\u03A4', { latin: 'T', script: 'Greek', codePoint: 0x03A4 }],    // Τ -> T
  ['\u03A5', { latin: 'Y', script: 'Greek', codePoint: 0x03A5 }],    // Υ -> Y
  ['\u0396', { latin: 'Z', script: 'Greek', codePoint: 0x0396 }],    // Ζ -> Z
]);

// ---------------------------------------------------------------------------
// Detection Functions
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HomoglyphFinding
 * @property {number} index - Character position in the input string
 * @property {string} char - The homoglyph character found
 * @property {string} latin - The Latin character it mimics
 * @property {string} script - The script the homoglyph belongs to
 * @property {number} codePoint - Unicode code point (decimal)
 */

/**
 * Detect homoglyph characters in the input string.
 * Scans for non-Latin characters that visually resemble Latin characters.
 *
 * @param {string} input - Text to scan for homoglyphs
 * @returns {HomoglyphFinding[]} Array of findings (empty if none detected)
 * @example
 * // Cyrillic 'а' (U+0430) looks like Latin 'a' (U+0061)
 * const findings = detectHomoglyphs('pаypal.com');
 * // findings: [{ index: 1, char: 'а', latin: 'a', script: 'Cyrillic', codePoint: 1072 }]
 *
 * @example
 * // Clean text returns empty array
 * const clean = detectHomoglyphs('paypal.com');
 * // clean: []
 */
export function detectHomoglyphs(input) {
  if (!input || typeof input !== 'string') return [];

  const findings = [];

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const mapping = HOMOGLYPH_MAP.get(char);
    if (mapping) {
      findings.push({
        index: i,
        char,
        latin: mapping.latin,
        script: mapping.script,
        codePoint: mapping.codePoint,
      });
    }
  }

  return findings;
}

/**
 * Check if a string contains mixed scripts (Latin + non-Latin lookalikes).
 * This is the primary indicator of a potential homograph attack.
 *
 * @param {string} input - Text to check
 * @returns {{ mixed: boolean, scripts: string[], findings: HomoglyphFinding[] }}
 * @example
 * const result = checkMixedScript('аpple.com');
 * // result: { mixed: true, scripts: ['Latin', 'Cyrillic'], findings: [...] }
 */
export function checkMixedScript(input) {
  if (!input || typeof input !== 'string') {
    return { mixed: false, scripts: [], findings: [] };
  }

  const findings = detectHomoglyphs(input);
  const hasLatin = /[a-zA-Z]/.test(input);
  const scriptSet = new Set(findings.map((f) => f.script));

  if (hasLatin) scriptSet.add('Latin');

  return {
    mixed: hasLatin && findings.length > 0,
    scripts: [...scriptSet].sort(),
    findings,
  };
}

/**
 * Normalize homoglyphs by replacing them with their Latin equivalents.
 *
 * @param {string} input - Text containing potential homoglyphs
 * @returns {string} Text with homoglyphs replaced by Latin equivalents
 * @example
 * normalizeHomoglyphs('pаypal.com');
 * // 'paypal.com' (Cyrillic а replaced with Latin a)
 */
export function normalizeHomoglyphs(input) {
  if (!input || typeof input !== 'string') return input ?? '';

  let result = '';
  for (let i = 0; i < input.length; i++) {
    const mapping = HOMOGLYPH_MAP.get(input[i]);
    result += mapping ? mapping.latin : input[i];
  }
  return result;
}

/**
 * Get the full homoglyph mapping table.
 * Useful for debugging or extending the detector.
 *
 * @returns {Array<{ char: string, latin: string, script: string, codePoint: number }>}
 * @example
 * const mappings = getHomoglyphMap();
 * // mappings[0]: { char: 'а', latin: 'a', script: 'Cyrillic', codePoint: 1072 }
 */
export function getHomoglyphMap() {
  return [...HOMOGLYPH_MAP.entries()].map(([char, mapping]) => ({
    char,
    ...mapping,
  }));
}
