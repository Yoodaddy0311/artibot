/**
 * Unit tests for lib/autopilot/flamegraph.js
 *
 * Covers:
 *   - empty / null / non-array input → "no data" stub
 *   - input with only invalid rows → "no data" stub
 *   - single phase → one row, max-bar
 *   - multi-phase proportional bars
 *   - max-width clamp (too small → 5, too large → 200)
 *   - sort modes: 'phase' (default, input order) vs 'duration' (desc)
 *   - inline tokens + cost formatting
 *   - markdown code-fence framing
 *   - no ANSI escape codes
 *   - safe coercion of negatives / NaN
 *   - phase name alignment (padEnd)
 */
import { describe, expect, it } from 'vitest';
import { renderFlamegraph } from '../../lib/autopilot/flamegraph.js';

// eslint-disable-next-line no-control-regex -- need to assert NO ANSI escape codes
const ANSI = /\u001b\[/;

describe('renderFlamegraph — empty inputs', () => {
  it('returns stub for null input', () => {
    expect(renderFlamegraph(null)).toContain('flamegraph 데이터 없음');
  });

  it('returns stub for non-array input', () => {
    expect(renderFlamegraph({ phase: 'X' })).toContain('flamegraph 데이터 없음');
  });

  it('returns stub for empty array', () => {
    expect(renderFlamegraph([])).toContain('flamegraph 데이터 없음');
  });

  it('returns stub when every row is invalid (no phase)', () => {
    const out = renderFlamegraph([{ durationMs: 100 }, null, { phase: '' }]);
    expect(out).toContain('flamegraph 데이터 없음');
  });
});

describe('renderFlamegraph — single phase', () => {
  it('renders one row with full-width bar', () => {
    const out = renderFlamegraph([
      { phase: 'EXECUTE', durationMs: 5000, tokens: 1200, cost: 0.05 },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('```');
    expect(lines[lines.length - 1]).toBe('```');
    expect(out).toContain('EXECUTE');
    expect(out).toContain('5s');
    expect(out).toContain('1.2k');
    expect(out).toContain('$0.0500');
  });

  it('uses default max bar width of 50 cells', () => {
    const out = renderFlamegraph([
      { phase: 'X', durationMs: 1000, tokens: 0, cost: 0 },
    ]);
    expect(out).toMatch(/\u2588{50}/);
  });
});

describe('renderFlamegraph — width clamp', () => {
  it('clamps maxWidth < 5 up to 5', () => {
    const out = renderFlamegraph(
      [{ phase: 'X', durationMs: 100, tokens: 0, cost: 0 }],
      { maxWidth: 1 },
    );
    expect(out).toMatch(/\u2588{5}/);
  });

  it('clamps maxWidth > 200 down to 200', () => {
    const out = renderFlamegraph(
      [{ phase: 'X', durationMs: 100, tokens: 0, cost: 0 }],
      { maxWidth: 9999 },
    );
    expect(out).toMatch(/\u2588{200}/);
    expect(out).not.toMatch(/\u2588{201}/);
  });

  it('respects custom maxWidth within bounds', () => {
    const out = renderFlamegraph(
      [{ phase: 'X', durationMs: 1, tokens: 0, cost: 0 }],
      { maxWidth: 20 },
    );
    expect(out).toMatch(/\u2588{20}/);
  });
});

describe('renderFlamegraph — sort modes', () => {
  it('preserves input order by default (sort=phase)', () => {
    const out = renderFlamegraph([
      { phase: 'INTAKE', durationMs: 200, tokens: 0, cost: 0 },
      { phase: 'EXECUTE', durationMs: 1000, tokens: 0, cost: 0 },
      { phase: 'REPORT', durationMs: 50, tokens: 0, cost: 0 },
    ]);
    const intakeIdx = out.indexOf('INTAKE');
    const executeIdx = out.indexOf('EXECUTE');
    const reportIdx = out.indexOf('REPORT');
    expect(intakeIdx).toBeLessThan(executeIdx);
    expect(executeIdx).toBeLessThan(reportIdx);
  });

  it('sorts by duration descending when opts.sort = "duration"', () => {
    const out = renderFlamegraph([
      { phase: 'AAA', durationMs: 200, tokens: 0, cost: 0 },
      { phase: 'BBB', durationMs: 1000, tokens: 0, cost: 0 },
      { phase: 'CCC', durationMs: 50, tokens: 0, cost: 0 },
    ], { sort: 'duration' });
    const a = out.indexOf('AAA');
    const b = out.indexOf('BBB');
    const c = out.indexOf('CCC');
    expect(b).toBeLessThan(a);
    expect(a).toBeLessThan(c);
  });

  it('does not mutate the input array when sorting', () => {
    const rows = [
      { phase: 'A', durationMs: 100, tokens: 0, cost: 0 },
      { phase: 'B', durationMs: 1000, tokens: 0, cost: 0 },
    ];
    const before = JSON.stringify(rows);
    renderFlamegraph(rows, { sort: 'duration' });
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('renderFlamegraph — formatting', () => {
  it('contains no ANSI escape codes', () => {
    const out = renderFlamegraph([
      { phase: 'EXECUTE', durationMs: 60000, tokens: 1500000, cost: 12.345 },
    ]);
    expect(ANSI.test(out)).toBe(false);
  });

  it('formats tokens as M for million-scale', () => {
    const out = renderFlamegraph([
      { phase: 'X', durationMs: 100, tokens: 2_500_000, cost: 0 },
    ]);
    expect(out).toContain('2.5M');
  });

  it('formats short durations in ms', () => {
    const out = renderFlamegraph([
      { phase: 'X', durationMs: 250, tokens: 0, cost: 0 },
    ]);
    expect(out).toContain('250ms');
  });

  it('formats long durations as "m s"', () => {
    const out = renderFlamegraph([
      { phase: 'X', durationMs: 75_000, tokens: 0, cost: 0 },
    ]);
    expect(out).toContain('1m 15s');
  });

  it('coerces negative and NaN numeric fields to 0', () => {
    const out = renderFlamegraph([
      { phase: 'X', durationMs: -10, tokens: NaN, cost: -1 },
    ]);
    expect(out).toContain('$0.0000');
    expect(out).toContain('0 tok');
    expect(out).toContain('0ms');
  });

  it('aligns phase names with padEnd to longest', () => {
    const out = renderFlamegraph([
      { phase: 'A', durationMs: 100, tokens: 0, cost: 0 },
      { phase: 'LONGNAME', durationMs: 100, tokens: 0, cost: 0 },
    ]);
    const lines = out.split('\n').filter((l) => l !== '```');
    // Both bars should start at the same column.
    const barCol0 = lines[0].indexOf('\u2588');
    const barCol1 = lines[1].indexOf('\u2588');
    expect(barCol0).toBe(barCol1);
  });
});
