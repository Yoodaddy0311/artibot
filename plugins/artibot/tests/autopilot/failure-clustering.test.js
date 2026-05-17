/**
 * Tests for lib/autopilot/failure-clustering.js (v4.10.0 Track G).
 * Covers signature stability, cluster aggregation thresholds, and the
 * deterministic pattern → suggested-fix table.
 */

import { describe, expect, it } from 'vitest';
import {
  SUGGEST_FIX_MIN_COUNT,
  clusterFailures,
  extractErrorSignature,
  suggestFix,
} from '../../lib/autopilot/failure-clustering.js';

/**
 * Build a fully-formed error event with sensible defaults so individual
 * tests can override only the fields they care about.
 *
 * @param {Partial<{ts:string, sessionId:string, level:string, type:string, message:string}>} overrides
 * @returns {object}
 */
function makeEvent(overrides = {}) {
  return {
    ts: overrides.ts ?? '2026-05-17T00:00:00.000Z',
    sessionId: overrides.sessionId ?? 'ap-test-cluster-0001',
    level: overrides.level ?? 'error',
    type: overrides.type ?? 'log',
    message: overrides.message ?? 'something failed',
  };
}

describe('extractErrorSignature', () => {
  it('returns null for empty / non-object input', () => {
    expect(extractErrorSignature(null)).toBeNull();
    expect(extractErrorSignature(undefined)).toBeNull();
    expect(extractErrorSignature({ message: '' })).toBeNull();
    expect(extractErrorSignature({ message: '   ' })).toBeNull();
  });

  it('strips POSIX paths so two errors at different files collapse', () => {
    const a = makeEvent({ message: 'cannot read /home/u/foo/bar.js line 12' });
    const b = makeEvent({ message: 'cannot read /etc/x/baz.js line 99' });
    expect(extractErrorSignature(a)).toBe(extractErrorSignature(b));
  });

  it('strips Windows paths', () => {
    const a = makeEvent({ message: 'ENOENT: missing C:\\Users\\nowhe\\foo\\bar.js' });
    const b = makeEvent({ message: 'ENOENT: missing C:\\temp\\x\\y.js' });
    expect(extractErrorSignature(a)).toBe(extractErrorSignature(b));
  });

  it('strips numbers (line numbers, addresses)', () => {
    const a = makeEvent({ message: 'TypeError at line 42 col 7' });
    const b = makeEvent({ message: 'TypeError at line 9000 col 3' });
    expect(extractErrorSignature(a)).toBe(extractErrorSignature(b));
  });

  it('strips hex / long hashes', () => {
    const a = makeEvent({ message: 'crash at 0xdeadbeef during foo' });
    const b = makeEvent({ message: 'crash at 0x12345678 during foo' });
    expect(extractErrorSignature(a)).toBe(extractErrorSignature(b));
  });

  it('strips quoted strings (often filenames)', () => {
    const a = makeEvent({ message: 'unknown command "foo-bar"' });
    const b = makeEvent({ message: 'unknown command "baz-qux"' });
    expect(extractErrorSignature(a)).toBe(extractErrorSignature(b));
  });

  it('prefixes type for namespace separation', () => {
    const a = makeEvent({ type: 'lint-error', message: 'unused var' });
    const b = makeEvent({ type: 'test-fail', message: 'unused var' });
    expect(extractErrorSignature(a)).not.toBe(extractErrorSignature(b));
  });

  it('produces a stable, lowercased signature', () => {
    const sig = extractErrorSignature(makeEvent({ message: 'BOOM!!' }));
    expect(typeof sig).toBe('string');
    expect(sig).toEqual(sig.toLowerCase());
  });
});

describe('clusterFailures', () => {
  it('returns [] for non-array / empty input', () => {
    expect(clusterFailures(null)).toEqual([]);
    expect(clusterFailures([])).toEqual([]);
  });

  it('ignores non-error events by default', () => {
    const events = [
      makeEvent({ level: 'info', message: 'started' }),
      makeEvent({ level: 'warn', message: 'slow query' }),
    ];
    expect(clusterFailures(events)).toEqual([]);
  });

  it('includes warn-level events when includeWarn is set', () => {
    const events = [
      makeEvent({ level: 'warn', message: 'slow query happened' }),
      makeEvent({ level: 'warn', message: 'slow query happened' }),
    ];
    const clusters = clusterFailures(events, { includeWarn: true });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
  });

  it('aggregates identical-signature errors into one cluster with count', () => {
    const events = [
      makeEvent({ message: 'TypeError at /a/b.js:10' }),
      makeEvent({ message: 'TypeError at /c/d.js:99' }),
      makeEvent({ message: 'TypeError at /e/f.js:5' }),
    ];
    const clusters = clusterFailures(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(3);
  });

  it('tracks distinct sessionIds per cluster, sorted', () => {
    const events = [
      makeEvent({ sessionId: 'ap-002', message: 'fail at /a/b.js:10' }),
      makeEvent({ sessionId: 'ap-001', message: 'fail at /c/d.js:1' }),
      makeEvent({ sessionId: 'ap-001', message: 'fail at /a/b.js:1' }),
    ];
    const clusters = clusterFailures(events);
    expect(clusters[0].sessions).toEqual(['ap-001', 'ap-002']);
  });

  it('records firstSeen / lastSeen from event timestamps', () => {
    const events = [
      makeEvent({ ts: '2026-05-17T12:00:00.000Z', message: 'boom' }),
      makeEvent({ ts: '2026-05-15T08:00:00.000Z', message: 'boom' }),
      makeEvent({ ts: '2026-05-16T10:00:00.000Z', message: 'boom' }),
    ];
    const [cluster] = clusterFailures(events);
    expect(cluster.firstSeen).toBe('2026-05-15T08:00:00.000Z');
    expect(cluster.lastSeen).toBe('2026-05-17T12:00:00.000Z');
  });

  it('sorts clusters by count desc, firstSeen asc on ties', () => {
    // alpha collapses by path-strip → 1 entry.
    // beta collapses by number-strip → 2 entries.
    // gamma collapses by number-strip → 2 entries, earlier firstSeen.
    const events = [
      makeEvent({ message: 'alpha failed at /tmp/a.js' }),
      makeEvent({ ts: '2026-05-10T00:00:00.000Z', message: 'beta error code 1' }),
      makeEvent({ ts: '2026-05-11T00:00:00.000Z', message: 'beta error code 2' }),
      makeEvent({ ts: '2026-05-09T00:00:00.000Z', message: 'gamma fault at line 1' }),
      makeEvent({ ts: '2026-05-12T00:00:00.000Z', message: 'gamma fault at line 2' }),
    ];
    const clusters = clusterFailures(events);
    expect(clusters).toHaveLength(3);
    // beta(2) and gamma(2) tie → gamma (earlier firstSeen) comes first.
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].sampleMessage).toContain('gamma');
    expect(clusters[1].sampleMessage).toContain('beta');
    expect(clusters[2].count).toBe(1);
  });

  it('respects minCount threshold', () => {
    // "recurring foo" / "recurring bar" only collapse if we strip the
    // bare-word tail — they don't, so use number-stripping to force the
    // collapse instead. Three of these become one cluster of 3, plus the
    // one-off lone entry that minCount=2 filters out.
    const events = [
      makeEvent({ message: 'one-off totally distinct failure' }),
      makeEvent({ message: 'recurring failure at line 11' }),
      makeEvent({ message: 'recurring failure at line 22' }),
    ];
    const clusters = clusterFailures(events, { minCount: 2 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
  });

  it('drops events with no usable message', () => {
    const events = [
      makeEvent({ message: '' }),
      makeEvent({ message: '   ' }),
      makeEvent({ message: 'actual failure' }),
    ];
    expect(clusterFailures(events)).toHaveLength(1);
  });
});

describe('suggestFix', () => {
  it('returns null for malformed cluster', () => {
    expect(suggestFix(null)).toBeNull();
    expect(suggestFix({})).toBeNull();
  });

  it('returns null when count below threshold', () => {
    expect(SUGGEST_FIX_MIN_COUNT).toBeGreaterThan(0);
    const c = { count: SUGGEST_FIX_MIN_COUNT - 1, sampleMessage: 'ENOENT: missing file' };
    expect(suggestFix(c)).toBeNull();
  });

  it('matches ENOENT pattern', () => {
    const fix = suggestFix({ count: 5, sampleMessage: 'ENOENT: no such file' });
    expect(fix).not.toBeNull();
    expect(fix.patternId).toBe('enoent-missing-file');
    expect(fix.title).toMatch(/missing file/i);
  });

  it('matches permission-denied pattern', () => {
    const fix = suggestFix({ count: 3, sampleMessage: 'EACCES: permission denied' });
    expect(fix.patternId).toBe('permission-denied');
  });

  it('matches port-in-use pattern', () => {
    const fix = suggestFix({ count: 3, sampleMessage: 'EADDRINUSE: port 3000 in use' });
    expect(fix.patternId).toBe('port-in-use');
  });

  it('matches syntax-error pattern', () => {
    const fix = suggestFix({ count: 4, sampleMessage: 'SyntaxError: unexpected token }' });
    expect(fix.patternId).toBe('syntax-error');
  });

  it('matches null-deref pattern', () => {
    const fix = suggestFix({
      count: 3,
      sampleMessage: "TypeError: Cannot read properties of undefined (reading 'x')",
    });
    expect(fix.patternId).toBe('type-error-undefined');
  });

  it('matches lint-fail pattern', () => {
    const fix = suggestFix({ count: 3, sampleMessage: 'eslint: 5 errors, 2 warnings' });
    expect(fix.patternId).toBe('lint-fail');
  });

  it('returns null for unmatched message', () => {
    const fix = suggestFix({ count: 10, sampleMessage: 'totally novel exotic problem' });
    expect(fix).toBeNull();
  });

  it('honours custom minCount option', () => {
    const c = { count: 2, sampleMessage: 'ENOENT: no such file' };
    expect(suggestFix(c)).toBeNull();
    expect(suggestFix(c, { minCount: 2 }).patternId).toBe('enoent-missing-file');
  });

  it('echoes the count in the returned object', () => {
    const fix = suggestFix({ count: 7, sampleMessage: 'timeout after 30s' });
    expect(fix.count).toBe(7);
  });
});
