/**
 * Multilingual keyword-to-intent mapping.
 * Supports en, ko, ja.
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
    '留뚮뱾': 'action:build',
    '由щ럭': 'action:review',
    '寃??': 'action:review',
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
    '\u30C1\u30FC\u30E0': 'team:summon',
    '\u53EC\u559A': 'team:summon',
    '\u30D3\u30EB\u30C9': 'action:build',
    '\u4F5C\u6210': 'action:build',
    '\u5B9F\u88C5': 'action:implement',
    '\u30EC\u30D3\u30E5\u30FC': 'action:review',
    '\u691C\u67FB': 'action:review',
    '\u30C6\u30B9\u30C8': 'action:test',
    '\u4FEE\u6B63': 'action:fix',
    '\u30C7\u30D0\u30C3\u30B0': 'action:fix',
    '\u30EA\u30D5\u30A1\u30AF\u30BF': 'action:refactor',
    '\u30C7\u30D7\u30ED\u30A4': 'action:deploy',
    '\u30EA\u30EA\u30FC\u30B9': 'action:deploy',
    '\u30C9\u30AD\u30E5\u30E1\u30F3\u30C8': 'action:document',
    '\u5206\u6790': 'action:analyze',
    '\u8ABF\u67FB': 'action:analyze',
    '\u8AAC\u660E': 'action:explain',
    '\u8A2D\u8A08': 'action:design',
    '\u8A08\u753B': 'action:plan',
  },
};

/**
 * Find all matching intents for a text across all supported languages.
 * @param {string} text - User input text
 * @param {string[]} [languages=['en','ko','ja']] - Languages to scan
 * @returns {{ intent: string, keyword: string, lang: string }[]}
 */
export function matchKeywords(text, languages = ['en', 'ko', 'ja']) {
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
