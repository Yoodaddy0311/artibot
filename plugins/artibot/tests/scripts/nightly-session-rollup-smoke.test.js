import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  USAGE,
  resolveDefaultStoragePath,
  yesterdayKey,
} from '../../scripts/hooks/nightly-session-rollup.mjs';

describe('nightly-session-rollup (smoke)', () => {
  it('parseArgs with no flags returns defaults', () => {
    const opts = parseArgs([]);
    expect(typeof opts).toBe('object');
  });

  it('parseArgs --help sets help flag', () => {
    const opts = parseArgs(['--help']);
    expect(opts.help).toBe(true);
  });

  it('parseArgs --dry-run sets dryRun', () => {
    const opts = parseArgs(['--dry-run']);
    expect(opts.dryRun).toBe(true);
  });

  it('USAGE is a string or string[]', () => {
    const u = typeof USAGE === 'string' ? USAGE : USAGE.join('\n');
    expect(typeof u).toBe('string');
    expect(u.length).toBeGreaterThan(20);
  });

  it('resolveDefaultStoragePath returns a string path', () => {
    const p = resolveDefaultStoragePath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });

  it('yesterdayKey returns YYYY-MM-DD for a given nowMs', () => {
    const key = yesterdayKey(Date.parse('2026-04-25T12:00:00Z'));
    expect(typeof key).toBe('string');
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
