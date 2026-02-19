/**
 * Core module re-exports.
 * @module lib/core
 */

export { getPlatform, getNodeInfo, checkNodeVersion, getPluginRoot, resolveFromRoot } from './platform.js';

/**
 * Round a number to a given decimal precision.
 * @param {number} n - The number to round
 * @param {number} [precision=3] - Number of decimal places
 * @returns {number}
 */
export function round(n, precision = 3) {
  const factor = 10 ** precision;
  return Math.round(n * factor) / factor;
}
export { loadConfig, getConfig, resetConfig, ARTIBOT_DIR } from './config.js';
export { Cache, defaultCache } from './cache.js';
export { readStdinJSON, readStdin, writeJSON, writeText, writeError, writeHookResult } from './io.js';
export { debug, createDebugger, isDebugEnabled } from './debug.js';
export { exists, readJsonFile, writeJsonFile, readTextFile, ensureDir, listFiles, listDirs } from './file.js';
export { parseFrontmatter, loadSkills, exportForGemini, exportForCodex, exportForCursor, exportForAll } from './skill-exporter.js';
export {
  progressBar, statusLight, teamDashboard, workflowVisualizer, playbookVisualizer,
  taskBoard, timeline, fullDashboard, sectionHeader,
  color, supportsColor, getTermWidth, stripAnsi, BOX, BLOCK, SYMBOLS, COLORS, STATUS_MAP,
} from './tui.js';
