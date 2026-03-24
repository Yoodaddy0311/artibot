/**
 * Multilingual keyword-to-intent mapping.
 * Supports en, ko, ja, zh.
 * @module lib/intent/language
 */

/**
 * Keyword map: language -> keyword -> intent
 * Each keyword maps to an intent string.
 */
const KEYWORD_MAP = {
  en: {
    // Team / orchestration
    team: 'team:summon',
    summon: 'team:summon',
    spawn: 'team:summon',
    assemble: 'team:summon',
    // Build
    build: 'action:build',
    compile: 'action:build',
    create: 'action:build',
    implement: 'action:implement',
    // Review
    review: 'action:review',
    check: 'action:review',
    audit: 'action:review',
    // Test
    test: 'action:test',
    e2e: 'action:test',
    unittest: 'action:test',
    // Fix / debug
    fix: 'action:fix',
    debug: 'action:fix',
    troubleshoot: 'action:fix',
    resolve: 'action:fix',
    // Refactor
    refactor: 'action:refactor',
    cleanup: 'action:refactor',
    clean: 'action:refactor',
    // Deploy
    deploy: 'action:deploy',
    release: 'action:deploy',
    publish: 'action:deploy',
    // Document
    document: 'action:document',
    docs: 'action:document',
    readme: 'action:document',
    // Analyze
    analyze: 'action:analyze',
    investigate: 'action:analyze',
    explain: 'action:explain',
    // Plan
    plan: 'action:plan',
    estimate: 'action:plan',
    design: 'action:design',
  },
  ko: {
    '\uD300': 'team:summon',
    '\uC18C\uD658': 'team:summon',
    '\uBE4C\uB4DC': 'action:build',
    '\uC0DD\uC131': 'action:build',
    '\uAD6C\uD604': 'action:implement',
    '\uB9CC\uB4E4': 'action:build',
    '\uB9AC\uBDF0': 'action:review',
    '\uAC80\uD1A0': 'action:review',
    '\uAC10\uC0AC': 'action:review',
    '\uD14C\uC2A4\uD2B8': 'action:test',
    '\uC218\uC815': 'action:fix',
    '\uB514\uBC84\uADF8': 'action:fix',
    '\uBC84\uADF8': 'action:fix',
    '\uB9AC\uD329\uD130': 'action:refactor',
    '\uC815\uB9AC': 'action:refactor',
    '\uBC30\uD3EC': 'action:deploy',
    '\uB9B4\uB9AC\uC2A4': 'action:deploy',
    '\uBB38\uC11C': 'action:document',
    '\uBD84\uC11D': 'action:analyze',
    '\uC870\uC0AC': 'action:analyze',
    '\uC124\uBA85': 'action:explain',
    '\uC124\uACC4': 'action:design',
    '\uACC4\uD68D': 'action:plan',
    // Backward-compatibility aliases for previously garbled legacy strings.
    '鍮뚮뱶': 'action:build',
    '?앹꽦': 'action:build',
    '援ы쁽': 'action:implement',
    '留뚮뱾': 'action:build',
    '由щ럭': 'action:review',
    '寃??': 'action:review',
    '媛먯궗': 'action:review',
    '?뚯뒪??': 'action:test',
    '?섏젙': 'action:fix',
    '?붾쾭洹?': 'action:fix',
    '踰꾧렇': 'action:fix',
    '由ы뙥??': 'action:refactor',
    '?뺣━': 'action:refactor',
    '諛고룷': 'action:deploy',
    '由대━??': 'action:deploy',
    '臾몄꽌': 'action:document',
    '遺꾩꽍': 'action:analyze',
    '議곗궗': 'action:analyze',
    '?ㅻ챸': 'action:explain',
    '?ㅺ퀎': 'action:design',
    '怨꾪쉷': 'action:plan',
  },
  ja: {
    // Team / orchestration
    '\u30C1\u30FC\u30E0': 'team:summon',
    '\u53EC\u559A': 'team:summon',
    '\u62DB\u96C6': 'team:summon',
    // Build
    '\u30D3\u30EB\u30C9': 'action:build',
    '\u4F5C\u6210': 'action:build',
    '\u69CB\u7BC9': 'action:build',
    // Implement
    '\u5B9F\u88C5': 'action:implement',
    '\u958B\u767A': 'action:implement',
    // Review
    '\u30EC\u30D3\u30E5\u30FC': 'action:review',
    '\u691C\u67FB': 'action:review',
    '\u76E3\u67FB': 'action:review',
    '\u30B3\u30FC\u30C9\u30EC\u30D3\u30E5\u30FC': 'action:review',
    // Test
    '\u30C6\u30B9\u30C8': 'action:test',
    '\u5358\u4F53\u30C6\u30B9\u30C8': 'action:test',
    '\u30AB\u30D0\u30EC\u30C3\u30B8': 'action:test',
    '\u8A66\u9A13': 'action:test',
    // Fix / debug
    '\u4FEE\u6B63': 'action:fix',
    '\u30C7\u30D0\u30C3\u30B0': 'action:fix',
    '\u4FEE\u5FA9': 'action:fix',
    '\u30D0\u30B0': 'action:fix',
    '\u4E0D\u5177\u5408': 'action:fix',
    // Refactor
    '\u30EA\u30D5\u30A1\u30AF\u30BF': 'action:refactor',
    '\u30EA\u30D5\u30A1\u30AF\u30BF\u30EA\u30F3\u30B0': 'action:refactor',
    '\u6574\u7406': 'action:refactor',
    '\u6700\u9069\u5316': 'action:refactor',
    // Deploy
    '\u30C7\u30D7\u30ED\u30A4': 'action:deploy',
    '\u30EA\u30EA\u30FC\u30B9': 'action:deploy',
    '\u516C\u958B': 'action:deploy',
    // Document
    '\u30C9\u30AD\u30E5\u30E1\u30F3\u30C8': 'action:document',
    '\u6587\u66F8': 'action:document',
    '\u8AAC\u660E\u66F8': 'action:document',
    // Analyze
    '\u5206\u6790': 'action:analyze',
    '\u8ABF\u67FB': 'action:analyze',
    '\u89E3\u6790': 'action:analyze',
    // Explain
    '\u8AAC\u660E': 'action:explain',
    // Design / Plan
    '\u8A2D\u8A08': 'action:design',
    '\u30A2\u30FC\u30AD\u30C6\u30AF\u30C1\u30E3': 'action:design',
    '\u8A08\u753B': 'action:plan',
    // Security
    '\u30BB\u30AD\u30E5\u30EA\u30C6\u30A3': 'action:review',
    '\u8106\u5F31\u6027': 'action:review',
  },
  zh: {
    // Team / orchestration
    '\u56E2\u961F': 'team:summon',
    '\u53EC\u96C6': 'team:summon',
    '\u7EC4\u5EFA': 'team:summon',
    // Build / implement
    '\u5B9E\u73B0': 'action:implement',
    '\u5F00\u53D1': 'action:implement',
    '\u7F16\u5199': 'action:build',
    '\u521B\u5EFA': 'action:build',
    '\u6784\u5EFA': 'action:build',
    '\u751F\u6210': 'action:build',
    // Review
    '\u5BA1\u67E5': 'action:review',
    '\u68C0\u67E5': 'action:review',
    '\u5BA1\u8BA1': 'action:review',
    '\u4EE3\u7801\u5BA1\u67E5': 'action:review',
    // Test
    '\u6D4B\u8BD5': 'action:test',
    '\u5355\u5143\u6D4B\u8BD5': 'action:test',
    '\u8986\u76D6\u7387': 'action:test',
    '\u6D4B\u8BD5\u7528\u4F8B': 'action:test',
    // Fix / debug
    '\u8C03\u8BD5': 'action:fix',
    '\u4FEE\u590D': 'action:fix',
    '\u9519\u8BEF': 'action:fix',
    '\u7F3A\u9677': 'action:fix',
    '\u6545\u969C': 'action:fix',
    // Refactor
    '\u91CD\u6784': 'action:refactor',
    '\u6E05\u7406': 'action:refactor',
    '\u4F18\u5316': 'action:refactor',
    // Deploy
    '\u90E8\u7F72': 'action:deploy',
    '\u53D1\u5E03': 'action:deploy',
    '\u4E0A\u7EBF': 'action:deploy',
    // Document
    '\u6587\u6863': 'action:document',
    '\u8BF4\u660E': 'action:document',
    '\u6307\u5357': 'action:document',
    '\u6587\u6863\u5316': 'action:document',
    // Analyze
    '\u5206\u6790': 'action:analyze',
    '\u8C03\u67E5': 'action:analyze',
    '\u89E3\u6790': 'action:analyze',
    // Explain
    '\u89E3\u91CA': 'action:explain',
    // Design / Plan
    '\u8BBE\u8BA1': 'action:design',
    '\u67B6\u6784': 'action:design',
    '\u6A21\u5757': 'action:design',
    '\u8BA1\u5212': 'action:plan',
    '\u89C4\u5212': 'action:plan',
    // Security
    '\u5B89\u5168': 'action:review',
    '\u6F0F\u6D1E': 'action:review',
  },
};

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/** Korean syllable range: U+AC00–U+D7AF */
const KOREAN_RE = /[\uAC00-\uD7AF]/;

/** Japanese Hiragana (U+3040–U+309F) and Katakana (U+30A0–U+30FF) */
const JAPANESE_KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/;

/** CJK Unified Ideographs (U+4E00–U+9FFF) — shared by zh, ja, ko */
const CJK_IDEOGRAPH_RE = /[\u4E00-\u9FFF]/;

/**
 * Detect the primary language of input text.
 * Priority: Korean > Japanese > Chinese > English (default).
 *
 * @param {string} text - Input text
 * @returns {'ko'|'ja'|'zh'|'en'} Detected language code
 */
export function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'en';

  // Korean: has Hangul syllables
  if (KOREAN_RE.test(text)) return 'ko';

  // Japanese: has Hiragana or Katakana
  if (JAPANESE_KANA_RE.test(text)) return 'ja';

  // Chinese: has CJK ideographs but no Hangul or Kana
  if (CJK_IDEOGRAPH_RE.test(text)) return 'zh';

  return 'en';
}

// ---------------------------------------------------------------------------
// Keyword matching
// ---------------------------------------------------------------------------

/**
 * Find all matching intents for a text across all supported languages.
 * @param {string} text - User input text
 * @param {string[]} [languages=['en','ko','ja','zh']] - Languages to scan
 * @returns {{ intent: string, keyword: string, lang: string }[]}
 */
export function matchKeywords(text, languages = ['en', 'ko', 'ja', 'zh']) {
  const lower = text.toLowerCase();
  const matches = [];
  const seen = new Set();

  for (const lang of languages) {
    const map = KEYWORD_MAP[lang];
    if (!map) continue;
    for (const [keyword, intent] of Object.entries(map)) {
      if (lower.includes(keyword.toLowerCase())) {
        const key = `${intent}:${keyword}`;
        if (!seen.has(key)) {
          seen.add(key);
          matches.push({ intent, keyword, lang });
        }
      }
    }
  }

  return matches;
}

/**
 * Get unique intents from keyword matches.
 * @param {{ intent: string }[]} matches
 * @returns {string[]}
 */
export function uniqueIntents(matches) {
  return [...new Set(matches.map((m) => m.intent))];
}
