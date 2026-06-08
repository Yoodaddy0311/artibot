/**
 * Tests for the /theme registry + apply-engine pure helpers.
 *
 * @module tests/scripts/theme-registry
 */

import { describe, expect, it } from 'vitest';
import {
  buildOutputStyle,
  buildStatuslinePalette,
  buildWtScheme,
  isTheme,
  THEME_NAMES,
  THEMES,
} from '../../scripts/theme/registry.js';
import {
  findWtSettings,
  restoreSettings,
  restoreWtDefaults,
  withOutputStyle,
  withStatusLine,
  withWtScheme,
} from '../../scripts/theme-apply.js';

describe('theme registry', () => {
  it('ships neon-city, matrix and vaporwave', () => {
    expect(THEME_NAMES).toEqual(expect.arrayContaining(['neon-city', 'matrix', 'vaporwave']));
  });

  it('isTheme recognizes only registered themes', () => {
    expect(isTheme('neon-city')).toBe(true);
    expect(isTheme('nope')).toBe(false);
  });

  it('every theme has a full 16-color ANSI palette + signals + glyphs', () => {
    const keys = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite'];
    for (const name of THEME_NAMES) {
      const t = THEMES[name];
      for (const k of keys) expect(t.ansi[k], `${name}.${k}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(t.signals.primary).toHaveLength(3);
      expect(t.signals.accent).toHaveLength(3);
      expect(t.glyphs.fill).toBeTruthy();
    }
  });
});

describe('buildWtScheme', () => {
  it('builds an ARTIBOT-prefixed scheme with all colors', () => {
    const s = buildWtScheme('neon-city');
    expect(s.name).toBe('ARTIBOT NEON CITY');
    expect(s.background).toBe('#0A0014');
    expect(s.cyan).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(s.brightWhite).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
  it('returns null for unknown theme', () => {
    expect(buildWtScheme('nope')).toBeNull();
  });
});

describe('buildStatuslinePalette', () => {
  it('exposes signals + glyphs for the bash statusline', () => {
    const p = buildStatuslinePalette('matrix');
    expect(p.theme).toBe('matrix');
    expect(p.signals.primary).toEqual([0, 255, 65]);
    expect(p.glyphs.fill).toBe('▮');
  });
});

describe('buildOutputStyle', () => {
  it('frontmatter name equals the theme label for every theme (= settings.outputStyle activation value)', () => {
    // theme-apply sets settings.outputStyle = THEMES[name].label, which Claude Code
    // matches against the output-style file's frontmatter `name`. They must agree.
    for (const name of THEME_NAMES) {
      const md = buildOutputStyle(name);
      const m = md.match(/^---\nname: (.+)$/m);
      expect(m, name).toBeTruthy();
      expect(m[1].trim()).toBe(THEMES[name].label);
    }
  });

  it('emits frontmatter with the theme label and uses its glyphs', () => {
    const md = buildOutputStyle('neon-city');
    expect(md).toMatch(/^---\nname: NEON CITY/);
    expect(md).toContain('◢◤');
    expect(md).toContain('Do NOT decorate inside code blocks');
  });
});

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
