import { describe, expect, it } from 'vitest';
import {
  filterByWindow,
  filterEffortEligible,
  parseArgs,
  resolveMetricsPath,
  resolveTrailPath,
  runNightlyEffortTrainer,
  summarizeEpisodes,
  USAGE,
} from '../../scripts/hooks/nightly-effort-policy-trainer.mjs';

describe('nightly-effort-policy-trainer (smoke)', () => {
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
      const within = { ts: now - 1000 };
      const outside = { ts: now - 40 * 24 * 3600 * 1000 };
      const result = filterByWindow([within, outside], 30, now);
      expect(result.length).toBe(1);
    });

    it('returns empty when all out of window', () => {
      const now = 1_700_000_000_000;
      const old = { ts: now - 40 * 24 * 3600 * 1000 };
      expect(filterByWindow([old], 30, now).length).toBe(0);
    });

    it('returns all when no timestamps', () => {
      const eps = [{}, {}];
      expect(filterByWindow(eps, 30, Date.now()).length).toBe(2);
    });
  });

  describe('filterEffortEligible', () => {
    it('keeps episodes with a finite reward', () => {
      const eligible = { command: 'implement', effort: 'high', reward: 0.8, tokensUsed: 1200 };
      const noReward = { command: 'implement', effort: 'high' };
      const nanReward = { command: 'x', reward: Number.NaN };
      const result = filterEffortEligible([eligible, noReward, nanReward]);
      expect(result.length).toBe(1);
      expect(result[0].command).toBe('implement');
    });

    it('returns empty for empty input', () => {
      expect(filterEffortEligible([])).toEqual([]);
    });

    it('returns empty for null/undefined input', () => {
      expect(filterEffortEligible(null)).toEqual([]);
      expect(filterEffortEligible(undefined)).toEqual([]);
    });
  });

  describe('resolveTrailPath', () => {
    it('returns a string path', () => {
      const p = resolveTrailPath();
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });
  });

  describe('resolveMetricsPath', () => {
    it('returns the reward-metrics path', () => {
      const p = resolveMetricsPath();
      expect(typeof p).toBe('string');
      expect(p.endsWith('reward-metrics.json')).toBe(true);
    });
  });

  describe('summarizeEpisodes', () => {
    it('summarizes empty input safely', () => {
      const summary = summarizeEpisodes([], { bandShifts: {} });
      expect(summary.totalEpisodes).toBe(0);
      expect(summary.uniqueCommands).toBe(0);
    });

    it('tallies per-command and per-effort counts', () => {
      const summary = summarizeEpisodes(
        [
          { command: 'implement', effort: 'high', reward: 0.5 },
          { command: 'implement', effort: 'high', reward: 0.4 },
          { command: 'plan', effort: 'medium', reward: 0.2 },
        ],
        { bandShifts: { implement: 1 } },
      );
      expect(summary.uniqueCommands).toBe(2);
      expect(summary.commands.implement.count).toBe(2);
      expect(summary.commands.implement.known).toBe(true);
      expect(summary.commands.plan.known).toBe(false);
      expect(summary.efforts.high).toBe(2);
    });
  });

  describe('runNightlyEffortTrainer (cold-start no-op)', () => {
    it('skips and never writes a policy when episodes are below coldStart', async () => {
      const trail = [];
      const res = await runNightlyEffortTrainer({
        episodes: [
          { command: 'implement', effort: 'high', reward: 0.5, tokensUsed: 1000, ts: Date.now() },
        ],
        config: { coldStartEpisodes: 150 },
        // Route the ledger write to an isolated path inside the OS temp dir so
        // the suite never touches the repo runtime trail.
        trailPath: `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/artibot-effort-trail-smoke.json`,
        policyPath: `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/artibot-effort-policy-smoke.json`,
        logger: { info() {}, warn() {}, error() {} },
        nowMs: Date.now(),
      });
      void trail;
      expect(res.status).toBe('skipped');
      expect(res.reason).toBe('cold-start');
      expect(res.policy ?? null).toBe(null);
    });
  });
});
