import { describe, it, expect } from 'vitest';
import { detectAmbiguity } from '../../lib/intent/ambiguity.js';

describe('ambiguity', () => {
  describe('detectAmbiguity()', () => {
    it('returns not ambiguous for single intent', () => {
      const result = detectAmbiguity(['action:build']);
      expect(result.ambiguous).toBe(false);
      expect(result.score).toBe(0);
      expect(result.clarification).toBeNull();
    });

    it('returns not ambiguous for empty intents', () => {
      const result = detectAmbiguity([]);
      expect(result.ambiguous).toBe(false);
      expect(result.score).toBe(0);
    });

    it('detects ambiguity with multiple distinct intents', () => {
      // build + test = 2*25=50 base, >= default threshold 50
      const result = detectAmbiguity(['action:build', 'action:test']);
      expect(result.ambiguous).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.clarification).toBeTruthy();
    });

    it('reduces score for similar intent pairs', () => {
      // build + implement are a similar pair -> -20 similarity
      const similar = detectAmbiguity(['action:build', 'action:implement']);
      const distinct = detectAmbiguity(['action:build', 'action:test']);
      expect(similar.score).toBeLessThan(distinct.score);
    });

    it('adds penalty for cross-category intents', () => {
      // team + action = 2 categories -> +20 penalty
      const crossCat = detectAmbiguity(['team:summon', 'action:build']);
      // Same category
      const sameCat = detectAmbiguity(['action:build', 'action:test']);
      expect(crossCat.score).toBeGreaterThan(sameCat.score);
    });

    it('respects custom threshold', () => {
      // 2 intents = 50 base score. threshold 100 means not ambiguous
      const result = detectAmbiguity(['action:build', 'action:test'], 100);
      expect(result.ambiguous).toBe(false);
    });

    it('flags ambiguity with low threshold', () => {
      const result = detectAmbiguity(['action:build', 'action:implement'], 10);
      expect(result.ambiguous).toBe(true);
    });

    it('generates clarification for two intents', () => {
      const result = detectAmbiguity(['action:build', 'action:test'], 0);
      expect(result.clarification).toMatch(/build something.*or.*run tests/);
    });

    it('generates clarification for three intents', () => {
      const result = detectAmbiguity(['action:build', 'action:test', 'action:fix'], 0);
      expect(result.clarification).toContain(',');
      expect(result.clarification).toContain('or');
    });

    it('score increases with more intents', () => {
      const two = detectAmbiguity(['action:build', 'action:test']);
      const three = detectAmbiguity(['action:build', 'action:test', 'action:fix']);
      expect(three.score).toBeGreaterThan(two.score);
    });

    it('caps base score at 100', () => {
      const many = detectAmbiguity([
        'action:build', 'action:test', 'action:fix',
        'action:review', 'action:deploy',
      ]);
      // 5*25=125 but capped at 100 + categoryPenalty - similarity
      expect(many.score).toBeLessThanOrEqual(120);
    });

    it('score never goes below 0', () => {
      // build+implement = 50 base - 20 similarity = 30, no category penalty
      const result = detectAmbiguity(['action:build', 'action:implement']);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('handles unknown intents in clarification gracefully', () => {
      // Unknown intents won't have labels, intentToLabel returns null
      const result = detectAmbiguity(['unknown:x', 'unknown:y'], 0);
      expect(result.clarification).toBe('Could you clarify what you would like to do?');
    });
  });
});
