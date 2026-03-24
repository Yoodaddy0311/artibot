import { describe, expect, it } from 'vitest';
import { matchKeywords, uniqueIntents, detectLanguage } from '../../lib/intent/language.js';

describe('language', () => {
  describe('matchKeywords()', () => {
    it('matches English keywords', () => {
      const matches = matchKeywords('build my project');
      expect(matches.some((m) => m.intent === 'action:build' && m.lang === 'en')).toBe(true);
    });

    it('matches Korean keywords', () => {
      const matches = matchKeywords('\uD504\uB85C\uC81D\uD2B8 \uBE4C\uB4DC \uD574\uC918');
      expect(matches.some((m) => m.intent === 'action:build' && m.lang === 'ko')).toBe(true);
    });

    it('matches Japanese keywords', () => {
      const matches = matchKeywords('\u30C6\u30B9\u30C8\u3092\u5B9F\u884C');
      expect(matches.some((m) => m.intent === 'action:test' && m.lang === 'ja')).toBe(true);
    });

    it('is case-insensitive for English', () => {
      const matches = matchKeywords('BUILD the app');
      expect(matches.some((m) => m.intent === 'action:build')).toBe(true);
    });

    it('detects multiple intents in one text', () => {
      const matches = matchKeywords('build and test the feature');
      const intents = matches.map((m) => m.intent);
      expect(intents).toContain('action:build');
      expect(intents).toContain('action:test');
    });

    it('returns empty array when no keywords match', () => {
      const matches = matchKeywords('hello world');
      expect(matches).toEqual([]);
    });

    it('detects team:summon intent', () => {
      const matches = matchKeywords('summon the team');
      expect(matches.some((m) => m.intent === 'team:summon')).toBe(true);
    });

    it('can limit to specific languages', () => {
      const matches = matchKeywords('\uBE4C\uB4DC', ['ko']);
      expect(matches.every((m) => m.lang === 'ko')).toBe(true);
      expect(matches.length).toBeGreaterThan(0);
    });

    it('skips unknown language', () => {
      const matches = matchKeywords('build', ['xx']);
      expect(matches).toEqual([]);
    });

    it('deduplicates by intent+keyword combination', () => {
      const matches = matchKeywords('build build build');
      const buildMatches = matches.filter((m) => m.keyword === 'build' && m.lang === 'en');
      expect(buildMatches).toHaveLength(1);
    });

    it('matches review-related keywords', () => {
      const matches = matchKeywords('code review please');
      expect(matches.some((m) => m.intent === 'action:review')).toBe(true);
    });

    it('matches deploy keywords', () => {
      const matches = matchKeywords('deploy to production');
      expect(matches.some((m) => m.intent === 'action:deploy')).toBe(true);
    });

    it('matches fix/debug keywords', () => {
      const matches = matchKeywords('fix this bug');
      expect(matches.some((m) => m.intent === 'action:fix')).toBe(true);
    });

    it('matches refactor keywords', () => {
      const matches = matchKeywords('refactor the code');
      expect(matches.some((m) => m.intent === 'action:refactor')).toBe(true);
    });

    it('matches document keywords', () => {
      const matches = matchKeywords('write the docs');
      expect(matches.some((m) => m.intent === 'action:document')).toBe(true);
    });

    it('matches analyze keywords', () => {
      const matches = matchKeywords('analyze the codebase');
      expect(matches.some((m) => m.intent === 'action:analyze')).toBe(true);
    });

    it('matches plan/design keywords', () => {
      const matches = matchKeywords('plan the design');
      expect(matches.some((m) => m.intent === 'action:plan')).toBe(true);
      expect(matches.some((m) => m.intent === 'action:design')).toBe(true);
    });

    // ----- Chinese keyword tests -----

    it('matches Chinese implement keyword (\u5B9E\u73B0)', () => {
      const matches = matchKeywords('\u5B9E\u73B0\u8FD9\u4E2A\u529F\u80FD', ['zh']);
      expect(matches.some((m) => m.intent === 'action:implement' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese develop keyword (\u5F00\u53D1)', () => {
      const matches = matchKeywords('\u5F00\u53D1\u65B0\u6A21\u5757', ['zh']);
      expect(matches.some((m) => m.intent === 'action:implement' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese test keyword (\u6D4B\u8BD5)', () => {
      const matches = matchKeywords('\u8FD0\u884C\u6D4B\u8BD5', ['zh']);
      expect(matches.some((m) => m.intent === 'action:test' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese unit test keyword (\u5355\u5143\u6D4B\u8BD5)', () => {
      const matches = matchKeywords('\u5199\u5355\u5143\u6D4B\u8BD5', ['zh']);
      expect(matches.some((m) => m.intent === 'action:test' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese debug keyword (\u8C03\u8BD5)', () => {
      const matches = matchKeywords('\u8C03\u8BD5\u8FD9\u4E2A\u95EE\u9898', ['zh']);
      expect(matches.some((m) => m.intent === 'action:fix' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese fix keyword (\u4FEE\u590D)', () => {
      const matches = matchKeywords('\u4FEE\u590D\u9519\u8BEF', ['zh']);
      expect(matches.some((m) => m.intent === 'action:fix' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese refactor keyword (\u91CD\u6784)', () => {
      const matches = matchKeywords('\u91CD\u6784\u4EE3\u7801', ['zh']);
      expect(matches.some((m) => m.intent === 'action:refactor' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese optimize keyword (\u4F18\u5316)', () => {
      const matches = matchKeywords('\u4F18\u5316\u6027\u80FD', ['zh']);
      expect(matches.some((m) => m.intent === 'action:refactor' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese design keyword (\u8BBE\u8BA1)', () => {
      const matches = matchKeywords('\u8BBE\u8BA1\u67B6\u6784', ['zh']);
      expect(matches.some((m) => m.intent === 'action:design' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese security keyword (\u5B89\u5168)', () => {
      const matches = matchKeywords('\u5B89\u5168\u5BA1\u8BA1', ['zh']);
      expect(matches.some((m) => m.intent === 'action:review' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese document keyword (\u6587\u6863)', () => {
      const matches = matchKeywords('\u7F16\u5199\u6587\u6863', ['zh']);
      expect(matches.some((m) => m.intent === 'action:document' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese deploy keyword (\u90E8\u7F72)', () => {
      const matches = matchKeywords('\u90E8\u7F72\u5230\u751F\u4EA7', ['zh']);
      expect(matches.some((m) => m.intent === 'action:deploy' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese plan keyword (\u8BA1\u5212)', () => {
      const matches = matchKeywords('\u5236\u5B9A\u8BA1\u5212', ['zh']);
      expect(matches.some((m) => m.intent === 'action:plan' && m.lang === 'zh')).toBe(true);
    });

    it('matches Chinese team keyword (\u56E2\u961F)', () => {
      const matches = matchKeywords('\u53EC\u96C6\u56E2\u961F', ['zh']);
      expect(matches.some((m) => m.intent === 'team:summon' && m.lang === 'zh')).toBe(true);
    });

    it('includes zh by default', () => {
      const matches = matchKeywords('\u6D4B\u8BD5\u4EE3\u7801');
      expect(matches.some((m) => m.lang === 'zh')).toBe(true);
    });

    // ----- Enhanced Japanese keyword tests -----

    it('matches Japanese develop keyword (\u958B\u767A)', () => {
      const matches = matchKeywords('\u65B0\u6A5F\u80FD\u3092\u958B\u767A', ['ja']);
      expect(matches.some((m) => m.intent === 'action:implement' && m.lang === 'ja')).toBe(true);
    });

    it('matches Japanese build keyword (\u69CB\u7BC9)', () => {
      const matches = matchKeywords('\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u69CB\u7BC9', ['ja']);
      expect(matches.some((m) => m.intent === 'action:build' && m.lang === 'ja')).toBe(true);
    });

    it('matches Japanese bug keyword (\u30D0\u30B0)', () => {
      const matches = matchKeywords('\u30D0\u30B0\u3092\u76F4\u3059', ['ja']);
      expect(matches.some((m) => m.intent === 'action:fix' && m.lang === 'ja')).toBe(true);
    });

    it('matches Japanese fix keyword (\u4FEE\u5FA9)', () => {
      const matches = matchKeywords('\u30A8\u30E9\u30FC\u3092\u4FEE\u5FA9', ['ja']);
      expect(matches.some((m) => m.intent === 'action:fix' && m.lang === 'ja')).toBe(true);
    });

    it('matches Japanese unit test keyword (\u5358\u4F53\u30C6\u30B9\u30C8)', () => {
      const matches = matchKeywords('\u5358\u4F53\u30C6\u30B9\u30C8\u3092\u66F8\u304F', ['ja']);
      expect(matches.some((m) => m.intent === 'action:test' && m.lang === 'ja')).toBe(true);
    });

    it('matches Japanese refactoring keyword (\u30EA\u30D5\u30A1\u30AF\u30BF\u30EA\u30F3\u30B0)', () => {
      const matches = matchKeywords('\u30EA\u30D5\u30A1\u30AF\u30BF\u30EA\u30F3\u30B0\u3059\u308B', ['ja']);
      expect(matches.some((m) => m.intent === 'action:refactor' && m.lang === 'ja')).toBe(true);
    });

    it('matches Japanese optimization keyword (\u6700\u9069\u5316)', () => {
      const matches = matchKeywords('\u30D1\u30D5\u30A9\u30FC\u30DE\u30F3\u30B9\u6700\u9069\u5316', ['ja']);
      expect(matches.some((m) => m.intent === 'action:refactor' && m.lang === 'ja')).toBe(true);
    });

    it('matches Japanese document keyword (\u6587\u66F8)', () => {
      const matches = matchKeywords('\u6587\u66F8\u3092\u66F4\u65B0', ['ja']);
      expect(matches.some((m) => m.intent === 'action:document' && m.lang === 'ja')).toBe(true);
    });

    it('matches Japanese security keyword (\u30BB\u30AD\u30E5\u30EA\u30C6\u30A3)', () => {
      const matches = matchKeywords('\u30BB\u30AD\u30E5\u30EA\u30C6\u30A3\u76E3\u67FB', ['ja']);
      expect(matches.some((m) => m.intent === 'action:review' && m.lang === 'ja')).toBe(true);
    });

    it('matches Japanese publish keyword (\u516C\u958B)', () => {
      const matches = matchKeywords('\u30B5\u30A4\u30C8\u3092\u516C\u958B', ['ja']);
      expect(matches.some((m) => m.intent === 'action:deploy' && m.lang === 'ja')).toBe(true);
    });

    // ----- Mixed language tests -----

    it('detects Chinese and English in mixed input', () => {
      const matches = matchKeywords('build \u548C \u6D4B\u8BD5');
      expect(matches.some((m) => m.lang === 'en' && m.intent === 'action:build')).toBe(true);
      expect(matches.some((m) => m.lang === 'zh' && m.intent === 'action:test')).toBe(true);
    });

    it('detects Japanese and English in mixed input', () => {
      const matches = matchKeywords('please \u30C6\u30B9\u30C8 the code');
      expect(matches.some((m) => m.lang === 'ja' && m.intent === 'action:test')).toBe(true);
    });

    it('detects Korean and Chinese in mixed input', () => {
      const matches = matchKeywords('\uBE4C\uB4DC \u548C \u6D4B\u8BD5');
      expect(matches.some((m) => m.lang === 'ko' && m.intent === 'action:build')).toBe(true);
      expect(matches.some((m) => m.lang === 'zh' && m.intent === 'action:test')).toBe(true);
    });
  });

  describe('uniqueIntents()', () => {
    it('returns unique intent strings', () => {
      const matches = [
        { intent: 'action:build', keyword: 'build', lang: 'en' },
        { intent: 'action:build', keyword: 'create', lang: 'en' },
        { intent: 'action:test', keyword: 'test', lang: 'en' },
      ];
      const unique = uniqueIntents(matches);
      expect(unique).toEqual(['action:build', 'action:test']);
    });

    it('returns empty array for no matches', () => {
      expect(uniqueIntents([])).toEqual([]);
    });

    it('handles single match', () => {
      const matches = [{ intent: 'action:fix', keyword: 'fix', lang: 'en' }];
      expect(uniqueIntents(matches)).toEqual(['action:fix']);
    });
  });

  describe('detectLanguage()', () => {
    // Korean detection
    it('detects Korean text', () => {
      expect(detectLanguage('\uBC84\uADF8 \uC218\uC815\uD574\uC918')).toBe('ko');
    });

    it('detects Korean in mixed Korean-English text', () => {
      expect(detectLanguage('build \uD504\uB85C\uC81D\uD2B8')).toBe('ko');
    });

    // Japanese detection
    it('detects Japanese hiragana text', () => {
      expect(detectLanguage('\u3053\u308C\u3092\u30C6\u30B9\u30C8\u3057\u3066')).toBe('ja');
    });

    it('detects Japanese katakana text', () => {
      expect(detectLanguage('\u30C6\u30B9\u30C8\u3092\u5B9F\u884C')).toBe('ja');
    });

    it('detects Japanese in mixed Japanese-English text', () => {
      expect(detectLanguage('please \u30D3\u30EB\u30C9 the project')).toBe('ja');
    });

    // Chinese detection
    it('detects Chinese text (CJK ideographs only, no kana/hangul)', () => {
      expect(detectLanguage('\u4FEE\u590D\u8FD9\u4E2A\u9519\u8BEF')).toBe('zh');
    });

    it('detects Chinese in mixed Chinese-English text', () => {
      expect(detectLanguage('run \u6D4B\u8BD5 please')).toBe('zh');
    });

    // Priority: Korean > Japanese > Chinese
    it('prioritizes Korean over Chinese when Hangul present', () => {
      expect(detectLanguage('\uBC84\uADF8\u4FEE\u590D')).toBe('ko');
    });

    it('prioritizes Japanese over Chinese when kana present', () => {
      expect(detectLanguage('\u30C6\u30B9\u30C8\u5B9F\u884C')).toBe('ja');
    });

    // English / default
    it('detects English text', () => {
      expect(detectLanguage('build the project')).toBe('en');
    });

    it('returns en for empty string', () => {
      expect(detectLanguage('')).toBe('en');
    });

    it('returns en for null', () => {
      expect(detectLanguage(null)).toBe('en');
    });

    it('returns en for undefined', () => {
      expect(detectLanguage(undefined)).toBe('en');
    });

    it('returns en for non-string', () => {
      expect(detectLanguage(42)).toBe('en');
    });
  });
});
