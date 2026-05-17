/**
 * Tests for lib/autopilot/memory-surface.js (v4.11.0 Track K).
 * Covers threshold gating, markdown table rendering, truncation/escape,
 * and empty-input handling.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMemoryWarning,
  DEFAULT_RENDER_LIMIT,
  DEFAULT_SURFACE_THRESHOLD,
  shouldSurfaceWarning,
} from '../../lib/autopilot/memory-surface.js';

describe('shouldSurfaceWarning', () => {
  it('returns false for empty / non-array input', () => {
    expect(shouldSurfaceWarning([])).toBe(false);
    expect(shouldSurfaceWarning(null)).toBe(false);
    expect(shouldSurfaceWarning(undefined)).toBe(false);
  });

  it('returns false when all counts below threshold', () => {
    expect(shouldSurfaceWarning([{ count: 1 }, { count: 2 }])).toBe(false);
  });

  it('returns true when any count >= default threshold (3)', () => {
    expect(shouldSurfaceWarning([{ count: 3 }])).toBe(true);
    expect(shouldSurfaceWarning([{ count: 1 }, { count: 5 }])).toBe(true);
  });

  it('honours custom threshold', () => {
    expect(shouldSurfaceWarning([{ count: 2 }], { threshold: 2 })).toBe(true);
    expect(shouldSurfaceWarning([{ count: 2 }], { threshold: 10 })).toBe(false);
  });

  it('ignores malformed entries', () => {
    expect(shouldSurfaceWarning([null, undefined, {}, { count: 'lots' }])).toBe(false);
  });

  it('default threshold is 3', () => {
    expect(DEFAULT_SURFACE_THRESHOLD).toBe(3);
  });
});

describe('buildMemoryWarning', () => {
  it('returns empty string for empty input', () => {
    expect(buildMemoryWarning([])).toBe('');
    expect(buildMemoryWarning(null)).toBe('');
  });

  it('renders a GFM table with header', () => {
    const out = buildMemoryWarning([
      { count: 5, lastSeen: '2026-05-15T00:00:00.000Z', sampleMessage: 'ENOENT' },
    ]);
    expect(out).toContain('Past failures relevant to this goal');
    expect(out).toContain('| # | count | last seen | sample |');
    expect(out).toContain('| - | ----- | --------- | ------ |');
    expect(out).toContain('| 1 | 5 | 2026-05-15 | ENOENT |');
  });

  it('truncates long sample messages with ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = buildMemoryWarning([{ count: 3, sampleMessage: long }]);
    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(200));
  });

  it('escapes pipe characters in sample', () => {
    const out = buildMemoryWarning([{ count: 3, sampleMessage: 'foo|bar' }]);
    expect(out).toContain('foo\\|bar');
  });

  it('flattens newlines in sample', () => {
    const out = buildMemoryWarning([{ count: 3, sampleMessage: 'line1\nline2' }]);
    expect(out).toContain('line1 line2');
    expect(out.split('\n').filter((l) => l.startsWith('| 1'))).toHaveLength(1);
  });

  it('respects render limit (default 3)', () => {
    const failures = Array.from({ length: 10 }, (_, i) => ({
      count: i + 1, sampleMessage: `m${i}`,
    }));
    const out = buildMemoryWarning(failures);
    const rows = out.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    expect(rows).toHaveLength(DEFAULT_RENDER_LIMIT);
  });

  it('honours custom limit', () => {
    const failures = Array.from({ length: 5 }, (_, i) => ({ count: i + 1, sampleMessage: `m${i}` }));
    const out = buildMemoryWarning(failures, { limit: 2 });
    const rows = out.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    expect(rows).toHaveLength(2);
  });

  it('handles missing lastSeen / sampleMessage gracefully', () => {
    const out = buildMemoryWarning([{ count: 3, signature: 'sig-x' }]);
    expect(out).toContain('sig-x');
    expect(out).toContain('—');
  });

  it('honours custom header option', () => {
    const out = buildMemoryWarning([{ count: 3, sampleMessage: 'x' }], { header: 'Custom Heading' });
    expect(out).toContain('### Custom Heading');
  });

  it('default render limit is 3', () => {
    expect(DEFAULT_RENDER_LIMIT).toBe(3);
  });
});
