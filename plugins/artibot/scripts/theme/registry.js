#!/usr/bin/env node
/**
 * Artibot theme registry — data-driven terminal themes for the `/theme` command.
 *
 * Each theme defines: a 16-color ANSI palette (Windows Terminal scheme), two
 * RGB signal colors for the statusline gradient bar, neon glyphs, and a
 * cyberpunk-leaning output-style body. Pure data + pure builders so the engine
 * (theme-apply.js) and tests can consume them without side effects.
 *
 * Add a theme = add one entry here. No engine changes needed.
 */

/** @typedef {{primary:number[], accent:number[], danger:number[], dim:number[]}} Signals */

export const THEMES = {
  'neon-city': {
    label: 'NEON CITY',
    desc: '사이버펑크 2077 — 마젠타×시안 네온',
    bg: '#0A0014', fg: '#C8F8FF', cursor: '#FF006E', selection: '#7209B7',
    // statusline gradient endpoints (cyan → magenta) + accents
    signals: { primary: [0, 245, 255], accent: [255, 0, 110], danger: [255, 23, 68], dim: [70, 40, 90], warn: [255, 190, 11] },
    glyphs: { wrapL: '⟨', wrapR: '⟩', brL: '⟦', brR: '⟧', sep: '◢◤', fill: '▰', empty: '▱', modL: '▓▒░', modR: '░▒▓', spark: '⚡' },
    ansi: {
      black: '#1A0A12', red: '#FF1744', green: '#00FF41', yellow: '#FFBE0B',
      blue: '#00A3FF', purple: '#FF006E', cyan: '#00F5FF', white: '#C8F8FF',
      brightBlack: '#46285A', brightRed: '#FF5C8A', brightGreen: '#5CFFA0', brightYellow: '#FFE066',
      brightBlue: '#5CC8FF', brightPurple: '#FF00FF', brightCyan: '#7CFFFF', brightWhite: '#FFFFFF',
    },
  },

  matrix: {
    label: 'MATRIX',
    desc: '해커 그린 — 코드레인 모노크롬',
    bg: '#020A02', fg: '#00FF41', cursor: '#00FF41', selection: '#0B3D0B',
    signals: { primary: [0, 255, 65], accent: [0, 160, 40], danger: [255, 60, 60], dim: [10, 60, 10], warn: [180, 255, 120] },
    glyphs: { wrapL: '[', wrapR: ']', brL: '<', brR: '>', sep: '::', fill: '▮', empty: '▯', modL: '>>', modR: '<<', spark: '⛓' },
    ansi: {
      black: '#020A02', red: '#FF3C3C', green: '#00FF41', yellow: '#B6FF78',
      blue: '#1A8C3A', purple: '#2EAE5A', cyan: '#39FF88', white: '#9DFFB0',
      brightBlack: '#0B3D0B', brightRed: '#FF6E6E', brightGreen: '#5CFFA0', brightYellow: '#D4FFA0',
      brightBlue: '#39CC6A', brightPurple: '#5CFF9E', brightCyan: '#7CFFB8', brightWhite: '#E6FFE6',
    },
  },

  vaporwave: {
    label: 'VAPORWAVE',
    desc: '레트로 파스텔 — 핑크×퍼플 석양',
    bg: '#1A0B2E', fg: '#F7C8FF', cursor: '#FF6AD5', selection: '#4A2574',
    signals: { primary: [255, 106, 213], accent: [148, 116, 255], danger: [255, 95, 109], dim: [74, 37, 116], warn: [255, 214, 102] },
    glyphs: { wrapL: '▰', wrapR: '▰', brL: '▱', brR: '▱', sep: '✦', fill: '▰', empty: '▱', modL: '░▒▓', modR: '▓▒░', spark: '✿' },
    ansi: {
      black: '#1A0B2E', red: '#FF5F6D', green: '#7CF5C0', yellow: '#FFD666',
      blue: '#9474FF', purple: '#FF6AD5', cyan: '#6AD7FF', white: '#F7C8FF',
      brightBlack: '#4A2574', brightRed: '#FF8FA3', brightGreen: '#A6FFD8', brightYellow: '#FFE699',
      brightBlue: '#B49CFF', brightPurple: '#FF9CE6', brightCyan: '#9CE6FF', brightWhite: '#FFFFFF',
    },
  },
};

export const THEME_NAMES = Object.keys(THEMES);

/** Whether `name` is a registered theme. */
export function isTheme(name) {
  return Object.prototype.hasOwnProperty.call(THEMES, name);
}

/**
 * Build a Windows Terminal color scheme object from a theme.
 * Scheme name is prefixed `ARTIBOT ` so it never collides with user schemes.
 * @param {string} name
 * @returns {object|null}
 */
export function buildWtScheme(name) {
  const t = THEMES[name];
  if (!t) return null;
  return {
    name: `ARTIBOT ${t.label}`,
    background: t.bg,
    foreground: t.fg,
    cursorColor: t.cursor,
    selectionBackground: t.selection,
    ...t.ansi,
  };
}

/**
 * The compact palette the bash statusline reads (RGB triples + glyphs).
 * @param {string} name
 * @returns {object|null}
 */
export function buildStatuslinePalette(name) {
  const t = THEMES[name];
  if (!t) return null;
  return { theme: name, label: t.label, signals: t.signals, glyphs: t.glyphs };
}

/** Markdown output-style body for a theme (Claude Code native format). */
export function buildOutputStyle(name) {
  const t = THEMES[name];
  if (!t) return null;
  const g = t.glyphs;
  return `---
name: ${t.label}
description: Artibot ${t.label} terminal theme — box-art headers, neon glyphs, ${g.fill}${g.empty} status bars
---

You format every response in the "${t.label}" terminal aesthetic — flashy framing on structure, but information stays clear, accurate, and scannable. Style decorates; it never replaces substance.

## Formatting
- Section headers as neon dividers: \`── ${g.sep} TITLE ${g.sep} ──────────────\`. Full box for major sections only.
- Bullets use neon glyphs: \`▸\` primary, \`◈\` sub, \`⟫\` steps.
- Status tags: success → \`${g.brL} OK ${g.brR}\`, fail → \`${g.brL} FAIL ${g.brR}\`, warn → \`${g.brL} WARN ${g.brR}\`.
- Progress/completion: \`${g.fill}${g.empty}\` bars + \`${g.spark} ✦ ◈\` accents. Done = \`✦✧✦ COMPLETE ✦✧✦\`.
- Emphasis stays markdown-native (**bold**, \`code\`) — they get color from the terminal scheme.

## Hard limits (do NOT break)
- Do NOT decorate inside code blocks/commands — code stays plain and copy-pasteable.
- Do NOT reduce information density, omit detail, or trade correctness for flair.
- Tables, file paths, and evidence (file:line) stay clean and exact.
- Flashy on headers/dividers/status; plain on body prose.
`;
}
