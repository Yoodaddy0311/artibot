/**
 * Tests for tui-renderer.js — ANSI color helpers, box drawing, text formatting.
 *
 * @module tests/core/tui-renderer
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCK,
  BOX,
  COLORS,
  MODE_DISPLAY,
  STATUS_MAP,
  SYMBOLS,
  centerText,
  color,
  countStatuses,
  formatTimestamp,
  getTermWidth,
  padRight,
  stripAnsi,
  supportsColor,
  truncate,
} from '../../lib/core/tui-renderer.js';

// ---------------------------------------------------------------------------
// COLORS
// ---------------------------------------------------------------------------
describe('COLORS', () => {
  it('contains reset code', () => {
    expect(COLORS.reset).toContain('\x1b[');
    expect(COLORS.reset).toContain('0m');
  });

  it('contains standard foreground colors', () => {
    for (const name of ['red', 'green', 'yellow', 'blue', 'cyan', 'white']) {
      expect(COLORS).toHaveProperty(name);
      expect(COLORS[name]).toContain('\x1b[');
    }
  });

  it('contains background colors', () => {
    expect(COLORS).toHaveProperty('bgRed');
    expect(COLORS).toHaveProperty('bgGreen');
  });

  it('contains style modifiers', () => {
    expect(COLORS).toHaveProperty('bold');
    expect(COLORS).toHaveProperty('dim');
    expect(COLORS).toHaveProperty('italic');
  });
});

// ---------------------------------------------------------------------------
// BOX / BLOCK / SYMBOLS
// ---------------------------------------------------------------------------
describe('BOX', () => {
  it('contains all box drawing characters', () => {
    const expected = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight',
      'horizontal', 'vertical', 'teeRight', 'teeLeft', 'teeDown', 'teeUp', 'cross'];
    for (const key of expected) {
      expect(BOX).toHaveProperty(key);
      expect(typeof BOX[key]).toBe('string');
    }
  });
});

describe('BLOCK', () => {
  it('contains block characters', () => {
    expect(BLOCK).toHaveProperty('full');
    expect(BLOCK).toHaveProperty('light');
    expect(BLOCK).toHaveProperty('medium');
    expect(BLOCK).toHaveProperty('dark');
  });
});

describe('SYMBOLS', () => {
  it('contains expected symbols', () => {
    expect(SYMBOLS).toHaveProperty('check');
    expect(SYMBOLS).toHaveProperty('cross');
    expect(SYMBOLS).toHaveProperty('arrow');
    expect(SYMBOLS).toHaveProperty('bullet');
    expect(SYMBOLS).toHaveProperty('ellipsis');
  });
});

// ---------------------------------------------------------------------------
// STATUS_MAP / MODE_DISPLAY
// ---------------------------------------------------------------------------
describe('STATUS_MAP', () => {
  it('has entries for common statuses', () => {
    for (const key of ['ready', 'active', 'in_progress', 'blocked', 'idle', 'completed', 'pending', 'error']) {
      expect(STATUS_MAP).toHaveProperty(key);
      expect(STATUS_MAP[key]).toHaveProperty('icon');
      expect(STATUS_MAP[key]).toHaveProperty('label');
      expect(STATUS_MAP[key]).toHaveProperty('color');
    }
  });
});

describe('MODE_DISPLAY', () => {
  it('has entries for agent-teams, sub-agent, and direct', () => {
    for (const key of ['agent-teams', 'sub-agent', 'direct']) {
      expect(MODE_DISPLAY).toHaveProperty(key);
      expect(MODE_DISPLAY[key]).toHaveProperty('icon');
      expect(MODE_DISPLAY[key]).toHaveProperty('label');
      expect(MODE_DISPLAY[key]).toHaveProperty('barColor');
    }
  });
});

// ---------------------------------------------------------------------------
// supportsColor()
// ---------------------------------------------------------------------------
describe('supportsColor()', () => {
  const originalEnv = { ...process.env };
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true, writable: true });
  });

  it('returns false when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    delete process.env.FORCE_COLOR;
    expect(supportsColor()).toBe(false);
  });

  it('returns true when FORCE_COLOR is set', () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    expect(supportsColor()).toBe(true);
  });

  it('returns true for TTY stdout', () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
    expect(supportsColor()).toBe(true);
  });

  it('returns false for non-TTY stdout', () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true, writable: true });
    expect(supportsColor()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// color()
// ---------------------------------------------------------------------------
describe('color()', () => {
  it('wraps text in ANSI codes when colors supported', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    const result = color('hello', 'red');
    expect(result).toContain(COLORS.red);
    expect(result).toContain(COLORS.reset);
    expect(result).toContain('hello');
  });

  it('returns plain text when colors not supported', () => {
    process.env.NO_COLOR = '1';
    const result = color('hello', 'red', 'bold');
    expect(result).toBe('hello');
  });

  it('combines multiple styles', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    const result = color('hello', 'bold', 'red');
    expect(result).toContain(COLORS.bold);
    expect(result).toContain(COLORS.red);
  });

  it('handles unknown style names gracefully', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    const result = color('hello', 'nonexistent');
    expect(result).toContain('hello');
  });
});

// ---------------------------------------------------------------------------
// getTermWidth()
// ---------------------------------------------------------------------------
describe('getTermWidth()', () => {
  it('returns a positive number', () => {
    const width = getTermWidth();
    expect(width).toBeGreaterThan(0);
  });

  it('defaults to 80 when columns is undefined', () => {
    const original = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true, writable: true });
    expect(getTermWidth()).toBe(80);
    Object.defineProperty(process.stdout, 'columns', { value: original, configurable: true, writable: true });
  });
});

// ---------------------------------------------------------------------------
// stripAnsi()
// ---------------------------------------------------------------------------
describe('stripAnsi()', () => {
  it('removes ANSI escape sequences', () => {
    const colored = `${COLORS.red}hello${COLORS.reset}`;
    expect(stripAnsi(colored)).toBe('hello');
  });

  it('returns plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('removes multiple ANSI codes', () => {
    const text = `${COLORS.bold}${COLORS.red}bold red${COLORS.reset}`;
    expect(stripAnsi(text)).toBe('bold red');
  });
});

// ---------------------------------------------------------------------------
// truncate()
// ---------------------------------------------------------------------------
describe('truncate()', () => {
  it('returns string unchanged if shorter than maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long string with ellipsis', () => {
    const result = truncate('hello world', 6);
    expect(result).toHaveLength(6);
    expect(result).toContain(SYMBOLS.ellipsis);
  });

  it('returns empty string for null/undefined input', () => {
    expect(truncate(null, 10)).toBe('');
    expect(truncate(undefined, 10)).toBe('');
    expect(truncate('', 10)).toBe('');
  });

  it('handles exact length string', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// padRight()
// ---------------------------------------------------------------------------
describe('padRight()', () => {
  it('pads short string to width', () => {
    const result = padRight('hi', 5);
    expect(result).toHaveLength(5);
    expect(result).toBe('hi   ');
  });

  it('returns spaces for null/empty input', () => {
    expect(padRight(null, 5)).toBe('     ');
    expect(padRight('', 5)).toBe('     ');
  });

  it('slices string that exceeds width', () => {
    const result = padRight('hello world', 5);
    expect(result).toHaveLength(5);
  });

  it('handles ANSI-colored strings by visible length', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    const colored = color('hi', 'red');
    const result = padRight(colored, 10);
    const visible = stripAnsi(result);
    expect(visible.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// centerText()
// ---------------------------------------------------------------------------
describe('centerText()', () => {
  it('centers text in given width', () => {
    const result = centerText('hi', 10);
    expect(result).toHaveLength(10);
    expect(result.trim()).toBe('hi');
  });

  it('returns text unchanged if it fills the width', () => {
    const result = centerText('hello', 5);
    expect(result).toContain('hello');
  });

  it('returns text unchanged if wider than width', () => {
    const result = centerText('hello world', 5);
    expect(result).toContain('hello world');
  });

  it('balances padding on both sides', () => {
    const result = centerText('ab', 6);
    expect(result).toBe('  ab  ');
  });
});

// ---------------------------------------------------------------------------
// countStatuses()
// ---------------------------------------------------------------------------
describe('countStatuses()', () => {
  it('counts empty array', () => {
    const counts = countStatuses([]);
    expect(counts.active).toBe(0);
    expect(counts.ready).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.idle).toBe(0);
    expect(counts.completed).toBe(0);
  });

  it('counts active and in_progress together', () => {
    const teammates = [
      { status: 'active' },
      { status: 'in_progress' },
    ];
    expect(countStatuses(teammates).active).toBe(2);
  });

  it('counts each status category correctly', () => {
    const teammates = [
      { status: 'ready' },
      { status: 'blocked' },
      { status: 'completed' },
      { status: 'unknown_status' },
    ];
    const counts = countStatuses(teammates);
    expect(counts.ready).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.idle).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp()
// ---------------------------------------------------------------------------
describe('formatTimestamp()', () => {
  it('formats a Date object to HH:MM:SS', () => {
    const d = new Date('2026-01-15T14:30:45Z');
    const result = formatTimestamp(d);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('formats an ISO string', () => {
    const result = formatTimestamp('2026-01-15T14:30:45Z');
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('returns default for falsy input', () => {
    expect(formatTimestamp(null)).toBe('--:--:--');
    expect(formatTimestamp(undefined)).toBe('--:--:--');
    expect(formatTimestamp('')).toBe('--:--:--');
  });

  it('returns string representation for invalid date string', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});
