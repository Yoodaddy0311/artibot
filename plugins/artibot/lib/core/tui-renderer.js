/**
 * TUI rendering primitives and constants.
 * Provides ANSI color helpers, box-drawing characters, status maps,
 * and text formatting utilities used by tui.js.
 *
 * Zero dependencies - uses only Node.js built-ins and UTF-8 characters.
 * @module lib/core/tui-renderer
 */

// ─────────────────────────────────────────────
// ANSI color helpers
// ─────────────────────────────────────────────

const ESC = '\x1b[';

export const COLORS = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  // Foreground
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,
  // Background
  bgRed: `${ESC}41m`,
  bgGreen: `${ESC}42m`,
  bgYellow: `${ESC}43m`,
  bgBlue: `${ESC}44m`,
  bgMagenta: `${ESC}45m`,
  bgCyan: `${ESC}46m`,
  bgWhite: `${ESC}47m`,
};

/**
 * Apply ANSI color to text. Returns plain text when colors are disabled.
 * @param {string} text
 * @param {...string} styles - Color/style names from COLORS
 * @returns {string}
 */
export function color(text, ...styles) {
  if (!supportsColor()) return text;
  const prefix = styles.map((s) => COLORS[s] || '').join('');
  return `${prefix}${text}${COLORS.reset}`;
}

/**
 * Check if the terminal supports colors.
 * Respects NO_COLOR and FORCE_COLOR environment variables.
 * @returns {boolean}
 */
export function supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

/**
 * Get the current terminal width, with a safe default.
 * @returns {number}
 */
export function getTermWidth() {
  return process.stdout.columns || 80;
}

// ─────────────────────────────────────────────
// Box drawing characters
// ─────────────────────────────────────────────

export const BOX = {
  topLeft: '\u250C',     // ┌
  topRight: '\u2510',    // ┐
  bottomLeft: '\u2514',  // └
  bottomRight: '\u2518', // ┘
  horizontal: '\u2500',  // ─
  vertical: '\u2502',    // │
  teeRight: '\u251C',    // ├
  teeLeft: '\u2524',     // ┤
  teeDown: '\u252C',     // ┬
  teeUp: '\u2534',       // ┴
  cross: '\u253C',       // ┼
};

export const BLOCK = {
  full: '\u2588',   // █
  light: '\u2591',  // ░
  medium: '\u2592', // ▒
  dark: '\u2593',   // ▓
};

export const SYMBOLS = {
  bullet: '\u25CF',    // ●
  circle: '\u25CB',    // ○
  arrow: '\u2192',     // →
  arrowBold: '\u25B6', // ▶
  check: '\u2713',     // ✓
  cross: '\u2717',     // ✗
  dash: '\u2500',      // ─
  ellipsis: '\u2026',  // …
};

// ─────────────────────────────────────────────
// Status and mode maps
// ─────────────────────────────────────────────

export const STATUS_MAP = {
  ready: { icon: '\uD83D\uDFE2', label: 'READY', color: 'green' },      // 🟢
  active: { icon: '\uD83D\uDFE1', label: 'ACTIVE', color: 'yellow' },    // 🟡
  in_progress: { icon: '\uD83D\uDFE1', label: 'IN_PROGRESS', color: 'yellow' },
  blocked: { icon: '\uD83D\uDD34', label: 'BLOCKED', color: 'red' },     // 🔴
  idle: { icon: '\u26AA', label: 'IDLE', color: 'gray' },                // ⚪
  completed: { icon: '\uD83D\uDFE2', label: 'DONE', color: 'green' },
  pending: { icon: '\u26AA', label: 'PENDING', color: 'gray' },
  error: { icon: '\uD83D\uDD34', label: 'ERROR', color: 'red' },
};

export const MODE_DISPLAY = {
  'agent-teams': { icon: '\uD83D\uDE80', label: 'AGENT TEAMS', barColor: 'green', desc: 'Full P2P team orchestration' },
  'sub-agent': { icon: '\u26A1', label: 'SUB-AGENT', barColor: 'yellow', desc: 'Parallel delegation (no P2P)' },
  'direct': { icon: '\uD83D\uDD27', label: 'DIRECT', barColor: 'cyan', desc: 'Sequential self-execution' },
};

// ─────────────────────────────────────────────
// Text formatting utilities
// ─────────────────────────────────────────────

/**
 * Strip ANSI escape sequences from a string.
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Truncate a string to maxLen, adding ellipsis if needed.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + SYMBOLS.ellipsis;
}

/**
 * Pad a string to the right to a fixed width.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function padRight(str, width) {
  if (!str) return ' '.repeat(width);
  const visible = stripAnsi(str);
  if (visible.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - visible.length);
}

/**
 * Center text within a given width.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function centerText(str, width) {
  const visible = stripAnsi(str);
  if (visible.length >= width) return str;
  const left = Math.floor((width - visible.length) / 2);
  const right = width - visible.length - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

/**
 * Count teammates by status.
 * @param {import('./tui.js').TeammateInfo[]} teammates
 * @returns {object}
 */
export function countStatuses(teammates) {
  const counts = { active: 0, ready: 0, blocked: 0, idle: 0, completed: 0 };
  for (const t of teammates) {
    const s = t.status;
    if (s === 'active' || s === 'in_progress') counts.active++;
    else if (s === 'ready') counts.ready++;
    else if (s === 'blocked') counts.blocked++;
    else if (s === 'completed') counts.completed++;
    else counts.idle++;
  }
  return counts;
}

/**
 * Format a timestamp for display.
 * @param {string|Date} ts
 * @returns {string}
 */
export function formatTimestamp(ts) {
  if (!ts) return '--:--:--';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toTimeString().slice(0, 8);
}
