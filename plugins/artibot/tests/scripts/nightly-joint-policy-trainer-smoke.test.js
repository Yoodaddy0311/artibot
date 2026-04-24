import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  USAGE,
  filterByWindow,
  filterJointEligible,
  summarizeJointEpisodes,
  resolveTrailPath,
} from '../../scripts/hooks/nightly-joint-policy-trainer.mjs';

describe('nightly-joint-policy-trainer (smoke)', () => {
  describe('parseArgs', () => {
    it('parses default flags', () => {
      const opts = parseArgs([]);
      expect(opts.dryRun ?? false).toBe(false);
      expect(typeof opts.windowDays).toBe('number');
    });

    it('--dry-run flag', () => {
      const opts = parseArgs(['--dry-run']);
      expect(opts.dryRun).toBe(true);
    });

    it('--window-days value', () => {
      const opts = parseArgs(['--window-days', '7']);
      expect(opts.windowDays).toBe(7);
    });

    it('--help flag', () => {
      const opts = parseArgs(['--help']);
      expect(opts.help).toBe(true);
    });
  });

  describe('USAGE', () => {
    it('is a non-empty string', () => {
      const u = typeof USAGE === 'string' ? USAGE : USAGE.join('\n');
      expect(typeof u).toBe('string');
      expect(u.length).toBeGreaterThan(20);
    });
  });

  describe('filterByWindow', () => {
    it('filters episodes older than window', () => {
      const now = 1_700_000_000_000;
      const within = { timestamp: new Date(now - 1000).toISOString() };
      const outside = { timestamp: new Date(now - 40 * 24 * 3600 * 1000).toISOString() };
      const result = filterByWindow([within, outside], 30, now);
      expect(result.length).toBe(1);
    });

    it('returns empty when all out of window', () => {
      const now = 1_700_000_000_000;
      const old = { timestamp: new Date(now - 40 * 24 * 3600 * 1000).toISOString() };
      expect(filterByWindow([old], 30, now).length).toBe(0);
    });

    it('returns all when no timestamps', () => {
      const eps = [{}, {}];
      expect(filterByWindow(eps, 30, Date.now()).length).toBe(2);
    });
  });

  describe('filterJointEligible', () => {
    it('keeps episodes with agent + skillsUsed + reward + taskFamily', () => {
      const eligible = {
        agent: 'code-reviewer',
        skillsUsed: ['a'],
        taskFamily: 'code review',
        reward: 0.8,
      };
      const noAgent = { skillsUsed: ['a'], taskFamily: 'x', reward: 0.5 };
      const noSkills = { agent: 'x', skillsUsed: [], taskFamily: 'x', reward: 0.5 };
      const noReward = { agent: 'x', skillsUsed: ['a'], taskFamily: 'x' };
      const result = filterJointEligible([eligible, noAgent, noSkills, noReward]);
      expect(result.length).toBe(1);
      expect(result[0].agent).toBe('code-reviewer');
    });

    it('returns empty for empty input', () => {
      expect(filterJointEligible([])).toEqual([]);
    });

    it('returns empty for null/undefined input', () => {
      expect(filterJointEligible(null)).toEqual([]);
      expect(filterJointEligible(undefined)).toEqual([]);
    });
  });

  describe('resolveTrailPath', () => {
    it('returns a string path', () => {
      const p = resolveTrailPath();
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });
  });

  describe('summarizeJointEpisodes', () => {
    it('summarizes empty input safely', () => {
      const summary = summarizeJointEpisodes([], { correlation: {} });
      expect(typeof summary).toBe('object');
    });
  });
});
