import { describe, it, expect } from 'vitest';
import { getRecommendations, getBestRecommendation } from '../../lib/intent/trigger.js';

describe('trigger', () => {
  describe('getRecommendations()', () => {
    it('returns recommendations for known intents', () => {
      const results = getRecommendations(['action:build']);
      expect(results).toHaveLength(1);
      expect(results[0].intent).toBe('action:build');
      expect(results[0].type).toBe('action');
      expect(results[0].agents).toContain('planner');
      expect(results[0].commands).toContain('/build');
    });

    it('returns multiple recommendations for multiple intents', () => {
      const results = getRecommendations(['action:build', 'action:test']);
      expect(results).toHaveLength(2);
    });

    it('returns empty array for unknown intents', () => {
      expect(getRecommendations(['unknown:intent'])).toEqual([]);
    });

    it('returns empty array for empty input', () => {
      expect(getRecommendations([])).toEqual([]);
    });

    it('skips unknown intents and includes known ones', () => {
      const results = getRecommendations(['unknown', 'action:fix']);
      expect(results).toHaveLength(1);
      expect(results[0].intent).toBe('action:fix');
    });

    it('returns correct data for team:summon', () => {
      const results = getRecommendations(['team:summon']);
      expect(results[0].type).toBe('team');
      expect(results[0].agents).toContain('orchestrator');
      expect(results[0].commands).toContain('/spawn');
    });

    it('returns correct data for action:review', () => {
      const results = getRecommendations(['action:review']);
      expect(results[0].agents).toContain('code-reviewer');
      expect(results[0].agents).toContain('security-reviewer');
    });

    it('returns correct data for action:implement', () => {
      const results = getRecommendations(['action:implement']);
      expect(results[0].agents).toContain('planner');
      expect(results[0].agents).toContain('tdd-guide');
    });

    it('returns correct data for action:refactor', () => {
      const results = getRecommendations(['action:refactor']);
      expect(results[0].commands).toContain('/improve');
      expect(results[0].commands).toContain('/cleanup');
    });

    it('returns correct data for action:deploy', () => {
      const results = getRecommendations(['action:deploy']);
      expect(results[0].agents).toContain('devops-engineer');
    });

    it('returns correct data for action:explain', () => {
      const results = getRecommendations(['action:explain']);
      expect(results[0].agents).toEqual([]);
      expect(results[0].commands).toContain('/explain');
    });

    it('returns correct data for action:design', () => {
      const results = getRecommendations(['action:design']);
      expect(results[0].agents).toContain('architect');
      expect(results[0].agents).toContain('frontend-developer');
    });

    it('returns correct data for action:plan', () => {
      const results = getRecommendations(['action:plan']);
      expect(results[0].commands).toContain('/estimate');
      expect(results[0].commands).toContain('/task');
    });
  });

  describe('getBestRecommendation()', () => {
    it('prioritizes team intents over action intents', () => {
      const result = getBestRecommendation(['action:build', 'team:summon']);
      expect(result.intent).toBe('team:summon');
    });

    it('returns first action intent when no team intent', () => {
      const result = getBestRecommendation(['action:build', 'action:test']);
      expect(result.intent).toBe('action:build');
    });

    it('returns null for empty intents', () => {
      expect(getBestRecommendation([])).toBeNull();
    });

    it('returns null for unknown intents', () => {
      expect(getBestRecommendation(['unknown:intent'])).toBeNull();
    });

    it('returns the first known intent when some are unknown', () => {
      const result = getBestRecommendation(['unknown', 'action:fix']);
      expect(result.intent).toBe('action:fix');
    });

    it('includes full recommendation data', () => {
      const result = getBestRecommendation(['action:test']);
      expect(result).toHaveProperty('intent');
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('description');
      expect(result).toHaveProperty('agents');
      expect(result).toHaveProperty('commands');
    });
  });
});
