/**
 * Tests for the /theme registry (scripts/theme/registry.js).
 * Apply-engine helpers are tested in theme-apply.test.js.
 *
 * @module tests/scripts/registry
 */

import { describe, expect, it } from 'vitest';
import {
  buildOutputStyle,
  buildStatuslinePalette,
  buildVscodeTerminalColors,
  buildWtScheme,
  isTheme,
  THEME_NAMES,
  THEMES,
  VSCODE_TERMINAL_KEYS,
} from '../../scripts/theme/registry.js';

describe('theme registry', () => {
  it('ships neon-city, matrix, vaporwave, crt-amber and sakura', () => {
    expect(THEME_NAMES).toEqual(
      expect.arrayContaining(['neon-city', 'matrix', 'vaporwave', 'crt-amber', 'sakura']),
    );
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

describe('new themes: crt-amber & sakura', () => {
  // Spot-asserts on the two themes shipped in this batch. The generic loops
  // above (16-color palette, output-style, VS Code map) already cover them via
  // THEME_NAMES; these pin the theme-specific label + signal + glyph contract.
  it('crt-amber has the RETRO TERMINAL label, 3-tuple signals, and a single-cell fill glyph', () => {
    const t = THEMES['crt-amber'];
    expect(t.label).toBe('RETRO TERMINAL');
    expect(t.signals.primary).toHaveLength(3);
    expect(t.signals.accent).toHaveLength(3);
    expect(t.signals.danger).toHaveLength(3);
    expect(t.signals.dim).toHaveLength(3);
    expect([...t.glyphs.fill]).toHaveLength(1);
    expect(isTheme('crt-amber')).toBe(true);
  });

  it('sakura has the SAKURA label, 3-tuple signals, and a single-cell fill glyph', () => {
    const t = THEMES.sakura;
    expect(t.label).toBe('SAKURA');
    expect(t.signals.primary).toHaveLength(3);
    expect(t.signals.accent).toHaveLength(3);
    expect(t.signals.danger).toHaveLength(3);
    expect(t.signals.dim).toHaveLength(3);
    expect([...t.glyphs.fill]).toHaveLength(1);
    expect(isTheme('sakura')).toBe(true);
  });

  it('buildStatuslinePalette exposes both new themes with their signals', () => {
    for (const name of ['crt-amber', 'sakura']) {
      const p = buildStatuslinePalette(name);
      expect(p.theme).toBe(name);
      expect(p.signals.primary).toEqual(THEMES[name].signals.primary);
      expect(p.glyphs.fill).toBe(THEMES[name].glyphs.fill);
    }
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

describe('buildVscodeTerminalColors', () => {
  it('maps every theme palette onto exactly the managed VS Code terminal keys', () => {
    for (const name of THEME_NAMES) {
      const c = buildVscodeTerminalColors(name);
      expect(Object.keys(c).sort()).toEqual([...VSCODE_TERMINAL_KEYS].sort());
      for (const v of Object.values(c)) expect(v).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
  it('uses fg/bg and maps ansi purple → ansiMagenta', () => {
    const c = buildVscodeTerminalColors('matrix');
    expect(c['terminal.foreground']).toBe(THEMES.matrix.fg);
    expect(c['terminal.background']).toBe(THEMES.matrix.bg);
    expect(c['terminal.ansiMagenta']).toBe(THEMES.matrix.ansi.purple);
    expect(c['terminal.ansiGreen']).toBe(THEMES.matrix.ansi.green);
  });
  it('returns null for unknown theme', () => {
    expect(buildVscodeTerminalColors('nope')).toBeNull();
  });
});
