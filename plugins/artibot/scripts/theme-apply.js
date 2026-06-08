#!/usr/bin/env node
/**
 * `/theme` engine — apply / reset / list Artibot terminal themes.
 *
 * Applies a theme across three surfaces (each best-effort, each backed up):
 *   1. statusLine  — points ~/.claude/settings.json at statusline-themed.sh and
 *      writes the theme palette to ~/.claude/artibot/runtime/current-theme.json
 *   2. Windows Terminal — injects an `ARTIBOT <THEME>` color scheme + selects it
 *   3. output-style — writes ~/.claude/output-styles/<name>.md (activate via /output-style)
 *
 * Targets the INSTALLED locations (HOME-based) since that is what the live
 * session uses, regardless of where this script runs from.
 *
 * Usage: node theme-apply.js <theme|reset|list> [--json]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOutputStyle, buildStatuslinePalette, buildWtScheme, isTheme, THEME_NAMES, THEMES } from './theme/registry.js';

const HOME = homedir();
const ARTIBOT = join(HOME, '.claude', 'artibot');
const RUNTIME = join(ARTIBOT, 'runtime');
const SETTINGS = join(HOME, '.claude', 'settings.json');
const OUTPUT_STYLES = join(HOME, '.claude', 'output-styles');
const BACKUP = join(RUNTIME, 'theme-backup.json');
const DEFAULT_STATUSLINE = 'bash ~/.claude/artibot/scripts/hooks/statusline.sh';
const THEMED_STATUSLINE = 'bash ~/.claude/artibot/scripts/hooks/statusline-themed.sh';

function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Return a new settings object with statusLine.command set. Immutable. */
export function withStatusLine(settings, command) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return { ...s, statusLine: { type: (s.statusLine && s.statusLine.type) || 'command', ...(s.statusLine || {}), command } };
}

/**
 * Return a new Windows Terminal settings object with `scheme` injected (dedup
 * by name) and `profiles.defaults.colorScheme` set. Immutable.
 */
export function withWtScheme(wt, scheme) {
  const o = wt && typeof wt === 'object' ? wt : {};
  const schemes = (Array.isArray(o.schemes) ? o.schemes : []).filter((s) => s && s.name !== scheme.name);
  const profiles = o.profiles && typeof o.profiles === 'object' ? o.profiles : {};
  const defaults = profiles.defaults && typeof profiles.defaults === 'object' ? profiles.defaults : {};
  return {
    ...o,
    schemes: [...schemes, scheme],
    profiles: { ...profiles, defaults: { ...defaults, colorScheme: scheme.name } },
  };
}

/** First existing Windows Terminal settings.json path, or null. */
export function findWtSettings(env = process.env) {
  const la = env.LOCALAPPDATA;
  if (!la) return null;
  const cands = [
    join(la, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(la, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(la, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
  return cands.find((p) => existsSync(p)) || null;
}

/** Return a new settings object with the active output style set. Immutable. */
export function withOutputStyle(settings, style) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return { ...s, outputStyle: style };
}

/**
 * Restore statusLine + outputStyle on a settings object from a backup. Immutable.
 * A null/undefined `prevOutputStyle` means "had none" → the key is removed so the
 * default style returns (rather than being pinned to an empty value).
 */
export function restoreSettings(settings, backup, defaultStatusLine) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const b = backup && typeof backup === 'object' ? backup : {};
  const next = withStatusLine(s, b.prevStatus || defaultStatusLine);
  if (b.prevOutputStyle === null || b.prevOutputStyle === undefined) delete next.outputStyle;
  else next.outputStyle = b.prevOutputStyle;
  return next;
}

/**
 * Restore profiles.defaults.colorScheme on a WT settings object. Immutable.
 * null/undefined `prevColorScheme` → remove the key (back to WT's built-in default).
 */
export function restoreWtDefaults(wt, prevColorScheme) {
  const o = wt && typeof wt === 'object' ? wt : {};
  const profiles = o.profiles && typeof o.profiles === 'object' ? o.profiles : {};
  const defaults = { ...(profiles.defaults && typeof profiles.defaults === 'object' ? profiles.defaults : {}) };
  if (prevColorScheme === null || prevColorScheme === undefined) delete defaults.colorScheme;
  else defaults.colorScheme = prevColorScheme;
  return { ...o, profiles: { ...profiles, defaults } };
}

// ── I/O actions ──────────────────────────────────────────────────────────────

function captureBackup() {
  if (existsSync(BACKUP)) return; // first apply only
  const settings = readJson(SETTINGS, {});
  let prevStatus = settings.statusLine && settings.statusLine.command;
  if (!prevStatus || /statusline-(themed|neon)\.sh/.test(prevStatus)) prevStatus = DEFAULT_STATUSLINE;
  const wtPath = findWtSettings();
  const wt = wtPath ? readJson(wtPath, {}) : null;
  const prevColorScheme = wt && wt.profiles && wt.profiles.defaults ? (wt.profiles.defaults.colorScheme ?? null) : null;
  const prevOutputStyle = settings.outputStyle ?? null;
  writeJson(BACKUP, { prevStatus, prevColorScheme, prevOutputStyle, savedAt: new Date().toISOString() });
}

function applyTheme(name) {
  const notes = [];
  captureBackup();

  // 1. statusline palette + command + output-style activation (one settings write)
  writeJson(join(RUNTIME, 'current-theme.json'), buildStatuslinePalette(name));
  const settings = readJson(SETTINGS, {});
  // outputStyle matches the output-style file's frontmatter `name` (= theme label)
  writeJson(SETTINGS, withOutputStyle(withStatusLine(settings, THEMED_STATUSLINE), THEMES[name].label));
  notes.push('statusLine → themed (재시작 또는 화면 갱신 시 반영)');

  // 2. Windows Terminal scheme (best-effort)
  const wtPath = findWtSettings();
  if (wtPath) {
    const wt = readJson(wtPath, null);
    if (wt) {
      if (!existsSync(wtPath + '.artibot-backup')) writeFileSync(wtPath + '.artibot-backup', readFileSync(wtPath, 'utf8'));
      writeFileSync(wtPath, JSON.stringify(withWtScheme(wt, buildWtScheme(name)), null, 4));
      notes.push(`Windows Terminal → "ARTIBOT ${THEMES[name].label}" 적용`);
    } else { notes.push('Windows Terminal settings.json 파싱 실패 — 색상 스킵'); }
  } else {
    notes.push('Windows Terminal 미발견 — 색상 스킵 (다른 터미널은 컬러 스킴 수동 적용)');
  }

  // 3. output-style file (active selection already set on settings.outputStyle above)
  mkdirSync(OUTPUT_STYLES, { recursive: true });
  writeFileSync(join(OUTPUT_STYLES, `${name}.md`), buildOutputStyle(name));
  notes.push(`output-style → "${THEMES[name].label}" 자동 활성화 (적용: /clear 또는 새 세션)`);

  return notes;
}

function resetTheme() {
  const notes = [];
  const b = readJson(BACKUP, {});
  const settings = readJson(SETTINGS, {});
  writeJson(SETTINGS, restoreSettings(settings, b, DEFAULT_STATUSLINE));
  notes.push('statusLine + output-style → 기본 복원');

  const wtPath = findWtSettings();
  if (wtPath) {
    const wt = readJson(wtPath, null);
    if (wt) {
      writeFileSync(wtPath, JSON.stringify(restoreWtDefaults(wt, b.prevColorScheme), null, 4));
      notes.push('Windows Terminal colorScheme → 이전값 복원');
    }
  }
  return notes;
}

function main() {
  const arg = process.argv[2];
  const json = process.argv.includes('--json');
  if (!arg || arg === 'list') {
    const list = THEME_NAMES.map((n) => ({ name: n, label: THEMES[n].label, desc: THEMES[n].desc }));
    if (json) { process.stdout.write(JSON.stringify(list) + '\n'); return; }
    process.stdout.write('사용 가능한 테마:\n' + list.map((t) => `  ▸ ${t.name.padEnd(11)} — ${t.label} · ${t.desc}`).join('\n') + '\n\n적용: node theme-apply.js <name>  ·  원복: node theme-apply.js reset\n');
    return;
  }
  if (arg === 'reset') {
    const notes = resetTheme();
    process.stdout.write('테마 원복:\n' + notes.map((n) => `  ✓ ${n}`).join('\n') + '\n');
    return;
  }
  if (!isTheme(arg)) {
    process.stderr.write(`알 수 없는 테마: ${arg}\n사용 가능: ${THEME_NAMES.join(', ')}\n`);
    process.exit(1);
  }
  const notes = applyTheme(arg);
  process.stdout.write(`테마 적용: ${THEMES[arg].label}\n` + notes.map((n) => `  ✓ ${n}`).join('\n') + '\n');
}

const isMain = (() => {
  try { return resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) main();
