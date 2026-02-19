import { describe, it, expect } from 'vitest';
import { matchKeywords, uniqueIntents } from '../../lib/intent/language.js';

describe('language', () => {
  describe('matchKeywords()', () => {
    it('matches English keywords', () => {
      const matches = matchKeywords('build my project');
      expect(matches.some(m => m.intent === 'action:build' && m.lang === 'en')).toBe(true);
    });

    it('matches Korean keywords', () => {
      const matches = matchKeywords('프로젝트 빌드 해줘');
      expect(matches.some(m => m.intent === 'action:build' && m.lang === 'ko')).toBe(true);
    });

    it('matches Japanese keywords', () => {
      const matches = matchKeywords('テスト実行して');
      expect(matches.some(m => m.intent === 'action:test' && m.lang === 'ja')).toBe(true);
    });

    it('is case-insensitive for English', () => {
      const matches = matchKeywords('BUILD the app');
      expect(matches.some(m => m.intent === 'action:build')).toBe(true);
    });

    it('detects multiple intents in one text', () => {
      const matches = matchKeywords('build and test the feature');
      const intents = matches.map(m => m.intent);
      expect(intents).toContain('action:build');
      expect(intents).toContain('action:test');
    });

    it('returns empty array when no keywords match', () => {
      const matches = matchKeywords('hello world');
      expect(matches).toEqual([]);
    });

    it('detects team:summon intent', () => {
      const matches = matchKeywords('summon the team');
      expect(matches.some(m => m.intent === 'team:summon')).toBe(true);
    });

    it('can limit to specific languages', () => {
      const matches = matchKeywords('빌드', ['ko']);
      expect(matches.every(m => m.lang === 'ko')).toBe(true);
      expect(matches.length).toBeGreaterThan(0);
    });

    it('skips unknown language', () => {
      const matches = matchKeywords('build', ['xx']);
      expect(matches).toEqual([]);
    });

    it('deduplicates by intent+keyword combination', () => {
      // Same keyword should not appear twice
      const matches = matchKeywords('build build build');
      const buildMatches = matches.filter(m => m.keyword === 'build' && m.lang === 'en');
      expect(buildMatches).toHaveLength(1);
    });

    it('matches review-related keywords', () => {
      const matches = matchKeywords('code review please');
      expect(matches.some(m => m.intent === 'action:review')).toBe(true);
    });

    it('matches deploy keywords', () => {
      const matches = matchKeywords('deploy to production');
      expect(matches.some(m => m.intent === 'action:deploy')).toBe(true);
    });

    it('matches fix/debug keywords', () => {
      const matches = matchKeywords('fix this bug');
      expect(matches.some(m => m.intent === 'action:fix')).toBe(true);
    });

    it('matches refactor keywords', () => {
      const matches = matchKeywords('refactor the code');
      expect(matches.some(m => m.intent === 'action:refactor')).toBe(true);
    });

    it('matches document keywords', () => {
      const matches = matchKeywords('write the docs');
      expect(matches.some(m => m.intent === 'action:document')).toBe(true);
    });

    it('matches analyze keywords', () => {
      const matches = matchKeywords('analyze the codebase');
      expect(matches.some(m => m.intent === 'action:analyze')).toBe(true);
    });

    it('matches plan/design keywords', () => {
      const matches = matchKeywords('plan the design');
      expect(matches.some(m => m.intent === 'action:plan')).toBe(true);
      expect(matches.some(m => m.intent === 'action:design')).toBe(true);
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
});
