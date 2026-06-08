/**
 * Tests for scripts/theme-apply.js pure helpers (the apply/reset/backup logic
 * extracted from the I/O orchestration so it can be unit-tested).
 *
 * @module tests/scripts/theme-apply
 */

import { describe, expect, it } from 'vitest';
import {
  findWtSettings,
  restoreSettings,
  restoreWtDefaults,
  withOutputStyle,
  withStatusLine,
  withWtScheme,
} from '../../scripts/theme-apply.js';

describe('withStatusLine', () => {
  it('sets the command immutably and preserves other keys', () => {
    const before = { env: { X: '1' }, statusLine: { type: 'command', command: 'old' } };
    const after = withStatusLine(before, 'new');
    expect(after.statusLine.command).toBe('new');
    expect(after.env.X).toBe('1');
    expect(before.statusLine.command).toBe('old'); // immutable
  });
  it('handles missing statusLine', () => {
    expect(withStatusLine({}, 'cmd').statusLine).toEqual({ type: 'command', command: 'cmd' });
  });
});

describe('withWtScheme', () => {
  const scheme = { name: 'ARTIBOT NEON CITY', background: '#000' };
  it('appends the scheme and selects it on profiles.defaults', () => {
    const wt = { schemes: [{ name: 'Campbell' }], profiles: { defaults: { fontFace: 'Cascadia' }, list: [] } };
    const next = withWtScheme(wt, scheme);
    expect(next.schemes.map((s) => s.name)).toEqual(['Campbell', 'ARTIBOT NEON CITY']);
    expect(next.profiles.defaults.colorScheme).toBe('ARTIBOT NEON CITY');
    expect(next.profiles.defaults.fontFace).toBe('Cascadia'); // preserved
  });
  it('dedups by scheme name (idempotent re-apply)', () => {
    const wt = { schemes: [{ name: 'ARTIBOT NEON CITY', background: '#old' }] };
    const next = withWtScheme(wt, scheme);
    expect(next.schemes.filter((s) => s.name === 'ARTIBOT NEON CITY')).toHaveLength(1);
    expect(next.schemes[0].background).toBe('#000'); // replaced with new
  });
});

describe('findWtSettings', () => {
  it('returns null when LOCALAPPDATA is unset', () => {
    expect(findWtSettings({})).toBeNull();
  });
});

describe('withOutputStyle', () => {
  it('sets outputStyle immutably', () => {
    const before = { statusLine: { command: 'x' } };
    const after = withOutputStyle(before, 'MATRIX');
    expect(after.outputStyle).toBe('MATRIX');
    expect(after.statusLine.command).toBe('x');
    expect(before.outputStyle).toBeUndefined(); // immutable
  });
});

describe('restoreSettings (reset side)', () => {
  const DEF = 'bash ~/.claude/artibot/scripts/hooks/statusline.sh';

  it('restores statusLine + outputStyle from backup', () => {
    const cur = { statusLine: { command: 'themed' }, outputStyle: 'MATRIX' };
    const out = restoreSettings(cur, { prevStatus: 'orig.sh', prevOutputStyle: 'Explanatory' }, DEF);
    expect(out.statusLine.command).toBe('orig.sh');
    expect(out.outputStyle).toBe('Explanatory');
  });

  it('DELETES outputStyle when backup had none (null/undefined) → back to default style', () => {
    const cur = { statusLine: { command: 'themed' }, outputStyle: 'MATRIX' };
    expect('outputStyle' in restoreSettings(cur, { prevOutputStyle: null }, DEF)).toBe(false);
    expect('outputStyle' in restoreSettings(cur, {}, DEF)).toBe(false); // missing field
  });

  it('falls back to the default statusLine when backup lacks prevStatus', () => {
    expect(restoreSettings({}, {}, DEF).statusLine.command).toBe(DEF);
  });
});

describe('restoreWtDefaults (reset side)', () => {
  it('restores a previous colorScheme and preserves schemes', () => {
    const wt = { schemes: [{ name: 'ARTIBOT MATRIX' }], profiles: { defaults: { colorScheme: 'ARTIBOT MATRIX', fontFace: 'X' } } };
    const out = restoreWtDefaults(wt, 'Campbell');
    expect(out.profiles.defaults.colorScheme).toBe('Campbell');
    expect(out.profiles.defaults.fontFace).toBe('X');
    expect(out.schemes).toHaveLength(1); // schemes left intact
  });

  it('removes colorScheme when original had none (null/undefined)', () => {
    const wt = { profiles: { defaults: { colorScheme: 'ARTIBOT MATRIX' } } };
    expect('colorScheme' in restoreWtDefaults(wt, null).profiles.defaults).toBe(false);
    expect('colorScheme' in restoreWtDefaults(wt, undefined).profiles.defaults).toBe(false);
  });
});
