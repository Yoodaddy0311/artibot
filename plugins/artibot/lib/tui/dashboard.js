/**
 * Artibot visual progress dashboard.
 *
 * Aggregates runtime/*.json state files and renders a single-line status
 * suitable for the Claude Code statusline (or a multi-line full dashboard).
 *
 * Design goals:
 *   - Zero throw: missing files / malformed JSON must gracefully degrade.
 *   - Cheap: pure fs.readFile on small JSON; no network, no sub-process.
 *   - Config-gated: `dashboard.enabled === false` => empty string.
 *   - Terminal-aware: ANSI colors only when stdout is a TTY and NO_COLOR unset.
 *
 * @module lib/tui/dashboard
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────
// ANSI helpers (self-contained to avoid circular deps with lib/core/tui)
// ─────────────────────────────────────────────

const ESC = '\x1b[';
const ANSI = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  cyan: `${ESC}36m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  magenta: `${ESC}35m`,
  gray: `${ESC}90m`,
};

/**
 * @returns {boolean} true when ANSI escapes should be emitted.
 */
function canUseColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

/**
 * Wrap text with ANSI style codes, only when stdout supports color.
 * @param {string} text
 * @param {...string} styles
 * @returns {string}
 */
function paint(text, ...styles) {
  if (!canUseColor()) return text;
  const prefix = styles.map((s) => ANSI[s] || '').join('');
  if (!prefix) return text;
  return `${prefix}${text}${ANSI.reset}`;
}

// ─────────────────────────────────────────────
// Safe JSON readers
// ─────────────────────────────────────────────

/**
 * Read a JSON file at `filePath`. Swallow all errors and return null.
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Format a byte/token count compactly (e.g. 45_000 -> "45K", 1_200_000 -> "1.2M").
 * @param {number} n
 * @returns {string}
 */
function humanize(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1)}K`;
  }
  return String(n);
}

// ─────────────────────────────────────────────
// State reader (public)
// ─────────────────────────────────────────────

/**
 * Pick the first non-empty string from a list of (object, key) pairs.
 * @param {Array<[object|null, string]>} pairs
 * @returns {string|null}
 */
function pickString(pairs) {
  for (const [obj, key] of pairs) {
    if (obj && typeof obj[key] === 'string' && obj[key]) return obj[key];
  }
  return null;
}

/**
 * Extract the session token usage tuple from a parsed JSON payload.
 * @param {object|null} tokenJson
 * @returns {{used: number|null, total: number|null}}
 */
function pickTokens(tokenJson) {
  if (!tokenJson) return { used: null, total: null };
  const used = typeof tokenJson.totalTokens === 'number' ? tokenJson.totalTokens : null;
  const total = typeof tokenJson.contextLimit === 'number' ? tokenJson.contextLimit : null;
  return { used, total };
}

/**
 * Derive a 0..100 progress percentage for a single teammate.
 * Priority: explicit numeric `progress`, else `tasksCompleted/tasksTotal`.
 * Returns null when neither is available (so callers can omit the figure).
 * @param {object} t
 * @returns {number|null}
 */
function deriveProgress(t) {
  if (typeof t.progress === 'number' && Number.isFinite(t.progress)) {
    return Math.max(0, Math.min(100, Math.round(t.progress)));
  }
  const total = Number(t.tasksTotal);
  const done = Number(t.tasksCompleted);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(done) && done >= 0) {
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }
  return null;
}

/**
 * Extract and normalize the teammate roster, preserving the progress signal
 * (`progress` field, or derived from `tasksCompleted/tasksTotal`).
 * @param {object|null} teammatesJson
 * @returns {Array<{name: string, status?: string, progress: number|null}>}
 */
function pickTeammates(teammatesJson) {
  if (!teammatesJson || !Array.isArray(teammatesJson.teammates)) return [];
  return teammatesJson.teammates
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({ name: t.name, status: t.status, progress: deriveProgress(t) }));
}

/**
 * Read current runtime state from plugin `runtime/` JSON files.
 * Never throws; missing / malformed files become null fields.
 *
 * @param {string} pluginRoot - Absolute path to the plugin root.
 * @returns {Promise<{
 *   effort: string|null,
 *   command: string|null,
 *   taskBudget: number|null,
 *   tokens: {used: number|null, total: number|null},
 *   longContext: boolean,
 *   teammates: Array<{name: string, status?: string}>
 * }>}
 */
export async function readDashboardState(pluginRoot) {
  const empty = {
    effort: null,
    command: null,
    taskBudget: null,
    tokens: { used: null, total: null },
    longContext: false,
    teammates: [],
  };
  if (!pluginRoot || typeof pluginRoot !== 'string') return empty;

  const runtimeDir = path.join(pluginRoot, 'runtime');
  const effortJson = readJsonSafe(path.join(runtimeDir, 'current-effort.json'));
  const budgetJson = readJsonSafe(path.join(runtimeDir, 'current-task-budget.json'));
  const tokenJson = readJsonSafe(path.join(runtimeDir, 'token-usage-session.json'));
  const longCtxJson = readJsonSafe(path.join(runtimeDir, 'long-context-active.json'));
  const teammatesJson = readJsonSafe(path.join(runtimeDir, 'current-teammates.json'));

  const taskBudget =
    budgetJson && typeof budgetJson.budget === 'number' && budgetJson.budget > 0
      ? budgetJson.budget
      : null;

  return {
    effort: pickString([[effortJson, 'effort']]),
    command: pickString([[budgetJson, 'command'], [effortJson, 'command']]),
    taskBudget,
    tokens: pickTokens(tokenJson),
    longContext: Boolean(longCtxJson && longCtxJson.enabled === true),
    teammates: pickTeammates(teammatesJson),
  };
}

/**
 * Average the known per-teammate progress values into a single 0..100 figure.
 * Teammates without a progress signal are ignored. Returns null when none of
 * them carry progress (so the statusline can omit the field entirely).
 * @param {Array<{progress: number|null}>} teammates
 * @returns {number|null}
 */
function overallTeamProgress(teammates) {
  const known = teammates
    .map((t) => t.progress)
    .filter((p) => typeof p === 'number' && Number.isFinite(p));
  if (known.length === 0) return null;
  const sum = known.reduce((acc, p) => acc + p, 0);
  return Math.max(0, Math.min(100, Math.round(sum / known.length)));
}

// ─────────────────────────────────────────────
// Section builders
// ─────────────────────────────────────────────

/**
 * Build the list of rendered sections for the one-line statusline.
 * @param {object} state
 * @param {object} flags - Feature flags from config.dashboard
 * @returns {string[]} Already-painted section strings (order preserved).
 */
function buildSections(state, flags) {
  const out = [];

  out.push(paint('[artibot]', 'cyan', 'bold'));

  if (state.command) {
    out.push(paint(state.command, 'magenta'));
  }

  if (flags.showEffort && state.effort) {
    out.push(`effort=${paint(state.effort, 'yellow')}`);
  }

  if (flags.showTaskBudget && state.taskBudget) {
    out.push(`budget=${paint(humanize(state.taskBudget), 'green')}`);
  }

  if (typeof state.tokens.used === 'number') {
    const used = humanize(state.tokens.used);
    const total = state.tokens.total ? humanize(state.tokens.total) : null;
    const tokenText = total ? `${used}/${total}` : used;
    out.push(`tokens=${paint(tokenText, 'green')}`);
  }

  if (state.longContext) {
    out.push(`longCtx=${paint('on', 'green', 'bold')}`);
  }

  if (flags.showTeammates && state.teammates.length > 0) {
    const names = state.teammates.map((t) => t.name).slice(0, 3).join(',');
    const suffix = state.teammates.length > 3 ? `+${state.teammates.length - 3}` : '';
    out.push(`team=${paint(`${names}${suffix}`, 'cyan')}`);
    const overall = overallTeamProgress(state.teammates);
    if (overall !== null) {
      out.push(`prog=${paint(`${overall}%`, 'green')}`);
    }
  }

  return out;
}

/**
 * Resolve dashboard feature flags with safe fallbacks.
 * @param {object} config
 */
function resolveFlags(config) {
  const d = (config && config.dashboard) || {};
  return {
    enabled: d.enabled === true,
    showTeammates: d.showTeammates !== false,
    showEffort: d.showEffort !== false,
    showTaskBudget: d.showTaskBudget !== false,
  };
}

// ─────────────────────────────────────────────
// Public renderers
// ─────────────────────────────────────────────

/**
 * Render a single-line status suitable for the Claude Code statusline.
 *
 * @param {{pluginRoot: string, config: object}} inputs
 * @returns {Promise<string>} Single line (no trailing newline). Empty when disabled.
 */
export async function renderStatusLine({ pluginRoot, config } = {}) {
  const flags = resolveFlags(config);
  if (!flags.enabled) return '';

  const state = await readDashboardState(pluginRoot);
  const sections = buildSections(state, flags);
  if (sections.length <= 1) return ''; // only the [artibot] tag => nothing useful to show

  const sep = paint(' \u00b7 ', 'dim');
  return sections.join(sep);
}

/**
 * Render a multi-line dashboard for full-screen or log output.
 *
 * @param {{pluginRoot: string, config: object}} inputs
 * @returns {Promise<string>}
 */
export async function renderFullDashboard({ pluginRoot, config } = {}) {
  const flags = resolveFlags(config);
  if (!flags.enabled) return '';

  const state = await readDashboardState(pluginRoot);
  const lines = [];
  lines.push(paint('Artibot Dashboard', 'cyan', 'bold'));
  lines.push(paint('─────────────────', 'gray'));
  lines.push(`command   : ${state.command ?? paint('(idle)', 'dim')}`);
  if (flags.showEffort) {
    lines.push(`effort    : ${state.effort ?? paint('—', 'dim')}`);
  }
  if (flags.showTaskBudget) {
    lines.push(`budget    : ${state.taskBudget ? humanize(state.taskBudget) : paint('—', 'dim')}`);
  }
  const used = typeof state.tokens.used === 'number' ? humanize(state.tokens.used) : '—';
  const total = state.tokens.total ? humanize(state.tokens.total) : '';
  lines.push(`tokens    : ${used}${total ? `/${total}` : ''}`);
  lines.push(`longCtx   : ${state.longContext ? paint('on', 'green') : paint('off', 'dim')}`);
  if (flags.showTeammates) {
    const tm = state.teammates.length > 0
      ? state.teammates
        .map((t) => (typeof t.progress === 'number' ? `${t.name} ${t.progress}%` : t.name))
        .join(', ')
      : paint('(none)', 'dim');
    lines.push(`teammates : ${tm}`);
    const overall = overallTeamProgress(state.teammates);
    if (overall !== null) {
      lines.push(`progress  : ${paint(`${overall}%`, 'green')}`);
    }
  }
  return lines.join('\n');
}
