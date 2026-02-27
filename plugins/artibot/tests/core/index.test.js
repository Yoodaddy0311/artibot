import { describe, expect, it } from 'vitest';
import { round } from '../../lib/core/index.js';

describe('round()', () => {
  it('rounds to 3 decimal places by default', () => {
    expect(round(1.23456789)).toBe(1.235);
  });

  it('rounds to specified precision', () => {
    expect(round(1.23456789, 2)).toBe(1.23);
    expect(round(1.23456789, 5)).toBe(1.23457);
  });

  it('rounds to 0 decimal places', () => {
    expect(round(1.7, 0)).toBe(2);
    expect(round(1.4, 0)).toBe(1);
  });

  it('rounds negative numbers', () => {
    expect(round(-1.2345, 2)).toBe(-1.23);
  });

  it('returns integers unchanged with default precision', () => {
    expect(round(42)).toBe(42);
    expect(round(0)).toBe(0);
  });

  it('handles precision of 1', () => {
    expect(round(3.14159, 1)).toBe(3.1);
  });

  it('handles very small numbers', () => {
    expect(round(0.001234, 4)).toBe(0.0012);
  });

  it('handles rounding up at midpoint', () => {
    expect(round(1.5, 0)).toBe(2);
    expect(round(2.5, 0)).toBe(3);
  });
});
