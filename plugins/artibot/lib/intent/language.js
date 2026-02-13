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
    'team': 'team:summon',
    'summon': 'team:summon',
    'spawn': 'team:summon',
    'assemble': 'team:summon',
    // Build
    'build': 'action:build',
    'compile': 'action:build',
    'create': 'action:build',
    'implement': 'action:implement',
    // Review
    'review': 'action:review',
    'check': 'action:review',
    'audit': 'action:review',
    // Test
    'test': 'action:test',
    'e2e': 'action:test',
    'unittest': 'action:test',
    // Fix / debug
    'fix': 'action:fix',
    'debug': 'action:fix',
    'troubleshoot': 'action:fix',
    'resolve': 'action:fix',
    // Refactor
    'refactor': 'action:refactor',
    'cleanup': 'action:refactor',
    'clean': 'action:refactor',
    // Deploy
    'deploy': 'action:deploy',
    'release': 'action:deploy',
    'publish': 'action:deploy',
    // Document
    'document': 'action:document',
    'docs': 'action:document',
    'readme': 'action:document',
    // Analyze
    'analyze': 'action:analyze',
    'investigate': 'action:analyze',
    'explain': 'action:explain',
    // Plan
    'plan': 'action:plan',
    'estimate': 'action:plan',
    'design': 'action:design',
  },
  ko: {
    '팀': 'team:summon',
    '소환': 'team:summon',
    '빌드': 'action:build',
    '생성': 'action:build',
    '구현': 'action:implement',
    '만들': 'action:build',
    '리뷰': 'action:review',
    '검토': 'action:review',
    '감사': 'action:review',
    '테스트': 'action:test',
    '수정': 'action:fix',
    '디버그': 'action:fix',
    '버그': 'action:fix',
    '리팩터': 'action:refactor',
    '정리': 'action:refactor',
    '배포': 'action:deploy',
    '릴리스': 'action:deploy',
    '문서': 'action:document',
    '분석': 'action:analyze',
    '조사': 'action:analyze',
    '설명': 'action:explain',
    '설계': 'action:design',
    '계획': 'action:plan',
  },
  ja: {
    'チーム': 'team:summon',
    '召喚': 'team:summon',
    'ビルド': 'action:build',
    '作成': 'action:build',
    '実装': 'action:implement',
    'レビュー': 'action:review',
    '検査': 'action:review',
    'テスト': 'action:test',
    '修正': 'action:fix',
    'デバッグ': 'action:fix',
    'リファクタ': 'action:refactor',
    'デプロイ': 'action:deploy',
    'リリース': 'action:deploy',
    'ドキュメント': 'action:document',
    '分析': 'action:analyze',
    '調査': 'action:analyze',
    '説明': 'action:explain',
    '設計': 'action:design',
    '計画': 'action:plan',
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
