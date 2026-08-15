#!/usr/bin/env node
/**
 * `/theme` engine — apply / reset / list Artibot terminal themes.
 *
 * Applies a theme across three surfaces (each best-effort, each backed up):
 *   1. statusLine  — points ~/.claude/settings.json at statusline-themed.sh and
 *      writes the theme palette to ~/.claude/artibot/runtime/current-theme.json
 *   2. Windows Terminal — injects an `ARTIBOT <THEME>` color scheme + selects it
 *   3. output-style — writes ~/.claude/output-styles/<name>.md and selects it by
 *      setting `settings.outputStyle` in the same write as (1). No manual pick is
 *      needed; it takes effect on /clear or a new session. (Do NOT point users at
 *      `/output-style` — that command is a hidden deprecated stub as of CLI 2.1.23x
 *      and only prints "moved to /config".)
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
import { getPluginRoot } from '../lib/core/platform.js';
import { buildOutputStyle, buildStatuslinePalette, buildVscodeTerminalColors, buildWtScheme, isTheme, THEME_NAMES, THEMES, VSCODE_TERMINAL_KEYS } from './theme/registry.js';

const HOME = homedir();
const ARTIBOT = join(HOME, '.claude', 'artibot');
const RUNTIME = join(ARTIBOT, 'runtime');
const SETTINGS = join(HOME, '.claude', 'settings.json');
const OUTPUT_STYLES = join(HOME, '.claude', 'output-styles');
const BACKUP = join(RUNTIME, 'theme-backup.json');

/**
 * Resolve the shell command that `settings.json#statusLine.command` should run
 * for a statusline hook script, in an install-method-aware way.
 *
 * Two install layouts exist for the hook SCRIPTS (code, not data):
 *   - Legacy / full install (install.sh): scripts live at the STABLE path
 *     `~/.claude/artibot/scripts/hooks/`, which never changes across updates.
 *   - Native marketplace install: scripts live only inside the VERSIONED plugin
 *     cache (`…/plugins/cache/artibot/artibot/<version>/scripts/hooks/`), exposed
 *     to this process via `CLAUDE_PLUGIN_ROOT` / import.meta resolution.
 *
 * Because `statusLine.command` is PERSISTED into settings.json and re-run on
 * every render, we prefer the stable legacy path whenever the script exists
 * there: that keeps the command byte-identical for install.sh users AND immune
 * to version-dir churn on `/plugin` updates. Only when the legacy path is absent
 * (native-only install) do we fall back to the resolved plugin root — accepting
 * that a major update may require re-running `/theme` (documented in
 * commands/theme.md and the README install notes). Embedding a runtime resolver
 * in the persisted command was rejected: it would itself need a stable code path
 * to live at, which native install does not provide, so it moves the staleness
 * rather than removing it.
 *
 * @param {string} script - Hook script basename (e.g. `'statusline.sh'`).
 * @param {object} [deps] - Injectable dependencies (for tests).
 * @param {string} [deps.home] - Home directory (default: `os.homedir()`).
 * @param {() => string} [deps.pluginRoot] - Plugin-root resolver (default: `getPluginRoot`).
 * @param {(p: string) => boolean} [deps.exists] - Existence probe (default: `existsSync`).
 * @returns {string} The `bash …` command string to store in `statusLine.command`.
 */
export function resolveStatuslineCommand(script, deps = {}) {
  const home = deps.home ?? HOME;
  const existsFn = deps.exists ?? existsSync;
  const legacyScript = join(home, '.claude', 'artibot', 'scripts', 'hooks', script);
  if (existsFn(legacyScript)) {
    // Byte-identical to the historical hardcoded command; tilde stays literal.
    return `bash ~/.claude/artibot/scripts/hooks/${script}`;
  }
  const rootFn = deps.pluginRoot ?? getPluginRoot;
  // Forward-slash the absolute path so the `bash` invocation works on Git Bash
  // (Windows) as well as POSIX shells; quote it to tolerate spaces in the path.
  const abs = join(rootFn(), 'scripts', 'hooks', script).replace(/\\/g, '/');
  return `bash "${abs}"`;
}

const DEFAULT_STATUSLINE = resolveStatuslineCommand('statusline.sh');
const THEMED_STATUSLINE = resolveStatuslineCommand('statusline-themed.sh');

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

/** First existing VS Code (or Insiders/VSCodium) user settings.json path, or null. */
export function findVscodeSettings(env = process.env) {
  const appdata = env.APPDATA;
  if (!appdata) return null;
  const cands = [
    join(appdata, 'Code', 'User', 'settings.json'),
    join(appdata, 'Code - Insiders', 'User', 'settings.json'),
    join(appdata, 'VSCodium', 'User', 'settings.json'),
  ];
  return cands.find((p) => existsSync(p)) || null;
}

/** Merge terminal `colors` into workbench.colorCustomizations. Immutable. */
export function withVscodeTerminal(settings, colors) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const cc = s['workbench.colorCustomizations'];
  const base = cc && typeof cc === 'object' ? cc : {};
  return { ...s, 'workbench.colorCustomizations': { ...base, ...colors } };
}

/**
 * Reset side: remove the managed terminal keys from workbench.colorCustomizations,
 * then restore any values present in `prevColors`. Other custom keys are untouched;
 * an emptied colorCustomizations object is dropped entirely. Immutable.
 */
export function restoreVscodeTerminal(settings, prevColors) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const cc = s['workbench.colorCustomizations'];
  if (!cc || typeof cc !== 'object') return s;
  const next = { ...cc };
  for (const k of VSCODE_TERMINAL_KEYS) delete next[k];
  const prev = prevColors && typeof prevColors === 'object' ? prevColors : {};
  for (const k of Object.keys(prev)) next[k] = prev[k];
  const out = { ...s };
  if (Object.keys(next).length === 0) delete out['workbench.colorCustomizations'];
  else out['workbench.colorCustomizations'] = next;
  return out;
}

/** Subset of a VS Code settings' colorCustomizations matching our managed keys. */
function captureVscodeColors(settings) {
  const cc = settings && settings['workbench.colorCustomizations'];
  if (!cc || typeof cc !== 'object') return {};
  const out = {};
  for (const k of VSCODE_TERMINAL_KEYS) if (k in cc) out[k] = cc[k];
  return out;
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
  const vsPath = findVscodeSettings();
  const prevVscodeColors = vsPath ? captureVscodeColors(readJson(vsPath, {})) : {};
  writeJson(BACKUP, { prevStatus, prevColorScheme, prevOutputStyle, prevVscodeColors, savedAt: new Date().toISOString() });
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

  // 3. VS Code integrated-terminal colors (best-effort)
  const vsPath = findVscodeSettings();
  if (vsPath) {
    const vs = readJson(vsPath, null);
    if (vs) {
      if (!existsSync(vsPath + '.artibot-backup')) writeFileSync(vsPath + '.artibot-backup', readFileSync(vsPath, 'utf8'));
      writeJson(vsPath, withVscodeTerminal(vs, buildVscodeTerminalColors(name)));
      notes.push('VS Code 통합 터미널 색 적용 (저장 시 자동 반영)');
    } else { notes.push('VS Code settings.json 파싱 실패 — 색상 스킵 (주석 있으면 수동)'); }
  }

  // 4. output-style file (active selection already set on settings.outputStyle above)
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

  const vsPath = findVscodeSettings();
  if (vsPath) {
    const vs = readJson(vsPath, null);
    if (vs) {
      writeJson(vsPath, restoreVscodeTerminal(vs, b.prevVscodeColors));
      notes.push('VS Code 통합 터미널 색 → 이전값 복원');
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
