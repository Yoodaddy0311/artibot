import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLastTestStatus } from '../../lib/core/test-status.js';

/**
 * Unit tests for the test-status reader.
 *
 * Covers:
 *   - Missing file → no warning
 *   - Corrupt JSON → no warning
 *   - Fresh pass-only run → no warning, exists=true
 *   - Fresh with failures → warning with sample of failed files
 *   - Stale run (>24h) → stale=true, no warning even if failures
 *   - Custom TTL boundary
 *   - Truncation when >3 failed files
 */
describe('getLastTestStatus', () => {
  /** @type {string} */
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-test-status-'));
    mkdirSync(path.join(tmpRoot, 'runtime'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeStatus(payload) {
    writeFileSync(
      path.join(tmpRoot, 'runtime', 'last-test-result.json'),
      JSON.stringify(payload),
      'utf-8',
    );
  }

  it('returns exists=false and no warning when the file is missing', () => {
    const result = getLastTestStatus(tmpRoot);
    expect(result.exists).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.summary).toBeNull();
  });

  it('returns exists=false when JSON is corrupt', () => {
    writeFileSync(
      path.join(tmpRoot, 'runtime', 'last-test-result.json'),
      '{not-json',
      'utf-8',
    );
    const result = getLastTestStatus(tmpRoot);
    expect(result.exists).toBe(false);
    expect(result.warning).toBeNull();
  });

  it('returns no warning when fresh and all tests pass', () => {
    writeStatus({
      timestamp: new Date().toISOString(),
      totalTests: 100,
      passed: 100,
      failed: 0,
      failedFiles: [],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.exists).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.summary.totalTests).toBe(100);
  });

  it('emits a warning with sample of failed files when fresh + failures present', () => {
    writeStatus({
      timestamp: new Date().toISOString(),
      totalTests: 200,
      passed: 198,
      failed: 2,
      failedFiles: ['tests/cron/auto-cleanup-runner.test.js', 'tests/hooks/runtime-prompt.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.warning).toContain('2 failing test(s)');
    expect(result.warning).toContain('auto-cleanup-runner.test.js');
    expect(result.warning).toContain('runtime-prompt.test.js');
    expect(result.warning).not.toContain('+'); // no truncation suffix
  });

  it('truncates failedFiles to 3 with a "+N more" suffix', () => {
    writeStatus({
      timestamp: new Date().toISOString(),
      totalTests: 200,
      passed: 195,
      failed: 5,
      failedFiles: ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.warning).toContain('a.test.js, b.test.js, c.test.js');
    expect(result.warning).toContain('(+2 more)');
    expect(result.warning).not.toContain('d.test.js');
  });

  it('marks the result as stale and suppresses the warning when older than 24h', () => {
    const oldTs = Date.now() - 25 * 3600 * 1000;
    writeStatus({
      timestamp: new Date(oldTs).toISOString(),
      totalTests: 100,
      passed: 95,
      failed: 5,
      failedFiles: ['x.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.stale).toBe(true);
    expect(result.warning).toBeNull();
  });

  it('respects a custom ttlHours', () => {
    const oldTs = Date.now() - 2 * 3600 * 1000; // 2 hours ago
    writeStatus({
      timestamp: new Date(oldTs).toISOString(),
      totalTests: 10,
      passed: 9,
      failed: 1,
      failedFiles: ['only.test.js'],
    });
    // ttl=1h → stale, no warning
    const stale = getLastTestStatus(tmpRoot, { ttlHours: 1 });
    expect(stale.stale).toBe(true);
    expect(stale.warning).toBeNull();
    // ttl=4h → still fresh, warning fires
    const fresh = getLastTestStatus(tmpRoot, { ttlHours: 4 });
    expect(fresh.stale).toBe(false);
    expect(fresh.warning).toContain('1 failing test(s)');
  });

  it('renders age in minutes for runs younger than 1 hour', () => {
    const recentTs = Date.now() - 15 * 60 * 1000; // 15 min ago
    writeStatus({
      timestamp: new Date(recentTs).toISOString(),
      totalTests: 50,
      passed: 49,
      failed: 1,
      failedFiles: ['x.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.warning).toMatch(/\d+m ago/);
  });

  it('treats unparseable timestamp as stale (returns no warning)', () => {
    writeStatus({
      timestamp: 'not-a-date',
      totalTests: 5,
      passed: 4,
      failed: 1,
      failedFiles: ['x.test.js'],
    });
    const result = getLastTestStatus(tmpRoot);
    expect(result.stale).toBe(true);
    expect(result.warning).toBeNull();
  });
});
