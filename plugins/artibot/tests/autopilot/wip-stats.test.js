/**
 * Unit tests for lib/autopilot/wip-stats.js.
 *
 * All git interactions are stubbed via dependency injection (the `git` option),
 * so these tests run in any directory and never spawn a child process.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countWipCommits,
  DEFAULT_AGE_THRESHOLD_MS,
  DEFAULT_COUNT_THRESHOLD,
  formatAdvisoryLine,
  getOldestWipAgeMs,
  isWipSubject,
  resolveThresholdsFromEnv,
  shouldSuggestSquash,
} from '../../lib/autopilot/wip-stats.js';

/**
 * Build a stub `git` runner that returns canned stdout for the matching
 * subcommand. Unknown invocations throw so we catch unexpected calls.
 *
 * @param {Record<string, string | Error>} table - key = first arg (e.g. 'log')
 * @returns {(args: string[]) => string}
 */
function makeGitStub(table) {
  return (args) => {
    const key = args[0];
    const v = table[key];
    if (v instanceof Error) throw v;
    if (typeof v === 'string') return v;
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

describe('isWipSubject', () => {
  it('matches lowercase wip: prefix', () => {
    expect(isWipSubject('wip: snapshot 1')).toBe(true);
  });

  it('matches uppercase WIP bare word', () => {
    expect(isWipSubject('WIP refactor router')).toBe(true);
  });

  it('matches [WIP] bracket prefix', () => {
    expect(isWipSubject('[WIP] partial migration')).toBe(true);
  });

  it('matches scoped wip(scope): prefix', () => {
    expect(isWipSubject('wip(autopilot): mid-implementation')).toBe(true);
  });

  it('rejects feat: prefix', () => {
    expect(isWipSubject('feat: new endpoint')).toBe(false);
  });

  it('rejects subject containing wip mid-word', () => {
    expect(isWipSubject('fix: clean up swipe handler')).toBe(false);
  });

  it('returns false for non-string input', () => {
    expect(isWipSubject(undefined)).toBe(false);
    expect(isWipSubject(null)).toBe(false);
    expect(isWipSubject(42)).toBe(false);
  });
});

describe('countWipCommits', () => {
  it('counts every wip-prefixed line', () => {
    const git = makeGitStub({
      log: [
        'wip: a',
        'feat: b',
        'WIP c',
        'fix: d',
        'wip(scope): e',
      ].join('\n'),
    });
    expect(countWipCommits('HEAD', { git })).toBe(3);
  });

  it('returns 0 when git throws', () => {
    const git = makeGitStub({ log: new Error('not a git repo') });
    expect(countWipCommits('HEAD', { git })).toBe(0);
  });

  it('returns 0 on empty stdout', () => {
    const git = makeGitStub({ log: '' });
    expect(countWipCommits('HEAD', { git })).toBe(0);
  });

  it('respects since filter (passed through to git)', () => {
    let captured = null;
    const git = (args) => {
      captured = args;
      return 'wip: x';
    };
    countWipCommits('HEAD', { git, since: '2 days ago' });
    expect(captured.some((a) => a.includes('--since='))).toBe(true);
  });
});

describe('getOldestWipAgeMs', () => {
  const now = () => 1_000_000_000_000; // fixed reference

  it('returns 0 when no WIP commits exist', () => {
    const git = makeGitStub({
      log: [
        '999999000\tfeat: a',
        '999998000\tfix: b',
      ].join('\n'),
    });
    expect(getOldestWipAgeMs('HEAD', { git, now })).toBe(0);
  });

  it('finds the oldest WIP commit even when interleaved', () => {
    // now = 1_000_000_000_000 ms → 1_000_000_000 s.
    // wip ages: 100s, 5000s, 300s → oldest = 5000s.
    const git = makeGitStub({
      log: [
        '999999900\twip: newest',  // 100s ago
        '999998000\tfeat: not wip',
        '999995000\twip: oldest',  // 5000s ago
        '999999700\twip: middle',  // 300s ago
      ].join('\n'),
    });
    expect(getOldestWipAgeMs('HEAD', { git, now })).toBe(5000 * 1000);
  });

  it('returns 0 on git error', () => {
    const git = makeGitStub({ log: new Error('fatal') });
    expect(getOldestWipAgeMs('HEAD', { git, now })).toBe(0);
  });

  it('skips malformed lines without tab separator', () => {
    const git = makeGitStub({
      log: 'garbage no tab here\n999995000\twip: ok',
    });
    expect(getOldestWipAgeMs('HEAD', { git, now })).toBe(5000 * 1000);
  });

  it('returns 0 (not negative) when commit timestamp is in the future', () => {
    const git = makeGitStub({ log: '1000000010\twip: future' });
    expect(getOldestWipAgeMs('HEAD', { git, now })).toBe(0);
  });
});

describe('shouldSuggestSquash — count threshold boundary', () => {
  it('fires at exactly 10 commits (default threshold)', () => {
    expect(shouldSuggestSquash(10, 0)).toBe(true);
  });

  it('does NOT fire at 9 commits with low age', () => {
    expect(shouldSuggestSquash(9, 60_000)).toBe(false);
  });

  it('fires at 11 commits', () => {
    expect(shouldSuggestSquash(11, 0)).toBe(true);
  });

  it('does NOT fire when count is 0 regardless of age', () => {
    expect(shouldSuggestSquash(0, 99 * 60 * 60 * 1000)).toBe(false);
  });

  it('respects custom countThreshold override', () => {
    expect(shouldSuggestSquash(5, 0, { countThreshold: 5 })).toBe(true);
    expect(shouldSuggestSquash(4, 0, { countThreshold: 5 })).toBe(false);
  });
});

describe('shouldSuggestSquash — age threshold boundary', () => {
  const FOUR_H = 4 * 60 * 60 * 1000;

  it('fires at exactly 4h age (default threshold) with 1 commit', () => {
    expect(shouldSuggestSquash(1, FOUR_H)).toBe(true);
  });

  it('does NOT fire at 3h59m age with 1 commit', () => {
    expect(shouldSuggestSquash(1, FOUR_H - 60_000)).toBe(false);
  });

  it('fires at 4h1m age with 1 commit', () => {
    expect(shouldSuggestSquash(1, FOUR_H + 60_000)).toBe(true);
  });

  it('respects custom ageThresholdMs override', () => {
    const TWO_H = 2 * 60 * 60 * 1000;
    expect(shouldSuggestSquash(1, TWO_H, { ageThresholdMs: TWO_H })).toBe(true);
    expect(shouldSuggestSquash(1, TWO_H - 1, { ageThresholdMs: TWO_H })).toBe(false);
  });

  it('returns false on non-finite inputs', () => {
    expect(shouldSuggestSquash(NaN, FOUR_H)).toBe(false);
    expect(shouldSuggestSquash(5, Infinity)).toBe(false);
  });
});

describe('formatAdvisoryLine', () => {
  it('returns null when neither threshold is met', () => {
    expect(formatAdvisoryLine(2, 60_000)).toBeNull();
  });

  it('uses minutes for ages under 1h', () => {
    // 30m, count threshold met → fires
    const line = formatAdvisoryLine(12, 30 * 60 * 1000);
    expect(line).toMatch(/30m ago/);
  });

  it('uses hours with 1 decimal for ages 1h..10h', () => {
    const line = formatAdvisoryLine(12, 2.5 * 60 * 60 * 1000);
    expect(line).toMatch(/2\.5h ago/);
  });

  it('uses integer hours for ages >= 10h', () => {
    const line = formatAdvisoryLine(12, 12 * 60 * 60 * 1000);
    expect(line).toMatch(/12h ago/);
  });

  it('includes the /squash advisory', () => {
    const line = formatAdvisoryLine(12, 60 * 60 * 1000);
    expect(line).toContain('/squash');
    expect(line).toContain('[artibot:wip]');
  });
});

// v4.8.0 H-1: defaultGitRunner now uses execFileSync (argv form) instead of
// execSync (shell-string form). These tests exercise the real runner with a
// malicious cwd to verify shell metacharacters are NOT interpreted by a shell
// (no subshell is spawned) and that runner errors propagate up to the
// public-API safe defaults (0).
describe('countWipCommits / getOldestWipAgeMs — real runner shell-safety', () => {
  it('returns 0 when cwd contains shell metacharacters and is not a git repo', () => {
    // execFileSync('git', [...], { cwd: '/tmp/$(whoami);ls' }) — if this were
    // shell-form, the cwd would be interpreted by /bin/sh -c and the side
    // effects of `whoami;ls` could fire. In argv form, the cwd is simply
    // passed to Node's spawn() as a literal path. The path does not exist
    // so git throws ENOENT and our wrapper falls through to 0.
    const evilCwd = '/tmp/$(whoami);ls;`id`';
    expect(countWipCommits('HEAD', { cwd: evilCwd })).toBe(0);
    expect(getOldestWipAgeMs('HEAD', { cwd: evilCwd })).toBe(0);
  });

  it('returns 0 when branch name contains shell metacharacters and refs do not exist', () => {
    // Even if cwd is a real git repo, an injected branch arg is just a literal
    // ref name to `git log`. git will report `unknown revision` and we return 0.
    const evilBranch = 'HEAD;rm -rf /';
    expect(countWipCommits(evilBranch)).toBe(0);
  });
});

describe('resolveThresholdsFromEnv', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    delete process.env.ARTIBOT_WIP_COUNT_THRESHOLD;
    delete process.env.ARTIBOT_WIP_AGE_HOURS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('returns defaults when env vars are absent', () => {
    const t = resolveThresholdsFromEnv();
    expect(t.countThreshold).toBe(DEFAULT_COUNT_THRESHOLD);
    expect(t.ageThresholdMs).toBe(DEFAULT_AGE_THRESHOLD_MS);
  });

  it('parses ARTIBOT_WIP_COUNT_THRESHOLD as integer', () => {
    process.env.ARTIBOT_WIP_COUNT_THRESHOLD = '7';
    expect(resolveThresholdsFromEnv().countThreshold).toBe(7);
  });

  it('parses ARTIBOT_WIP_AGE_HOURS as hours', () => {
    process.env.ARTIBOT_WIP_AGE_HOURS = '2.5';
    expect(resolveThresholdsFromEnv().ageThresholdMs).toBe(2.5 * 3_600_000);
  });

  it('ignores invalid env values and falls back to defaults', () => {
    process.env.ARTIBOT_WIP_COUNT_THRESHOLD = 'notanumber';
    process.env.ARTIBOT_WIP_AGE_HOURS = '-5';
    const t = resolveThresholdsFromEnv();
    expect(t.countThreshold).toBe(DEFAULT_COUNT_THRESHOLD);
    expect(t.ageThresholdMs).toBe(DEFAULT_AGE_THRESHOLD_MS);
  });
});
