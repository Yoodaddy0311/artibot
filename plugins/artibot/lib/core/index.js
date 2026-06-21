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

/**
 * Clamp a value into the [0, 1] range. Non-numbers and NaN coerce to 0.
 * @param {number} value - Value to clamp
 * @returns {number}
 */
export function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Approximate characters per token for budget estimation. */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from character content.
 * Canonical implementation — other modules should import this.
 * @param {string} text - Raw text content
 * @param {number} [charsPerToken=4] - Characters-per-token ratio
 * @returns {number} Estimated token count
 */
export function estimateTokens(text, charsPerToken = CHARS_PER_TOKEN) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / charsPerToken) + 1;
}

export { loadConfig, getConfig, resetConfig, ARTIBOT_DIR } from './config.js';
export { Cache, defaultCache } from './cache.js';
export { readStdinJSON, readStdin, writeJSON, writeText, writeError, writeHookResult } from './io.js';
export { debug, createDebugger, isDebugEnabled } from './debug.js';
export { exists, readJsonFile, writeJsonFile, readTextFile, ensureDir, ensureDirSync, listFiles, listDirs } from './file.js';
export { parseFrontmatter, loadSkills, exportForGemini, exportForCodex, exportForCursor, exportForAll } from './skill-exporter.js';
export {
  progressBar, statusLight, teamDashboard, workflowVisualizer, playbookVisualizer,
  taskBoard, timeline, fullDashboard, sectionHeader,
  color, supportsColor, getTermWidth, stripAnsi, BOX, BLOCK, SYMBOLS, COLORS, STATUS_MAP,
} from './tui.js';
export { STATES, createLifecycle, getCurrentState, defaultLifecycle } from './lifecycle.js';
export { createExtensionRegistry, defaultRegistry } from './extension.js';
export { parsePlaybook, validatePlaybook, serializePlaybook, KNOWN_PATTERNS, KNOWN_ACTIONS } from './playbook-parser.js';
export { loadSystemPlaybooks, loadUserPlaybooks, saveUserPlaybook, listPlaybooks, getPlaybook } from './playbook-registry.js';
export { registerGuard, executeChain, listGuards, resetGuards, registerBuiltinGuards, normalizeCommand } from './guard-registry.js';
export { on, emit, getLastEvent, reset as resetEventBus, getStats as getEventBusStats } from './event-bus.js';

// Context Budget (Predictive token budget allocation)
export {
  createContextBudget,
  EWMA,
  predictTaskCost,
} from './context-budget.js';

// Marketplace (Plugin install/update system)
export {
  createInstallPlan,
  computeUpdateDiff,
  detectConflicts,
  parseSemver,
  checkUpdate,
} from './marketplace.js';
export { createMetricsCollector, defaultCollector } from './metrics-collector.js';
export { checkInstructionBudget, getSkillTokenEstimate, budgetReport } from './instruction-budget.js';
export { createSnapshot, formatForPrompt, estimateSnapshotTokens, SNAPSHOT_MAX_TOKENS } from './agent-memory-snapshot.js';

// Decision Trail (AGO Track G3 explainability)
export { recordDecision, queryDecisions, pruneDecisionTrail, getDecisionStats } from './decision-trail.js';

// Extension loader (plugin discovery + manifest validation)
export { validateManifest, loadExtension, discoverExtensions } from './extension-loader.js';

// Marketplace installer (install / uninstall / list)
export { installFromRegistry, installFromUrl, uninstall, listInstalled } from './marketplace-installer.js';

// Plain language (localization dictionary)
export { toPlainLanguage, getDictionary, registerDictionary } from './plain-language.js';

// User profile (skill-level signals & promotion)
export { getProfile, recordSignal, setSkillLevel, detectSkillLevel, configureProfilePath } from './user-profile.js';

// Redaction (centralized sensitive-token masking)
export { redactString, redactObject, GENERIC_PATTERNS, TAGGED_PATTERNS } from './redaction.js';

// Citation formatter (5 modes + lenticular bracket stripping)
export {
  CITATION_MODES,
  extractDomain,
  stripLenticularBrackets,
  dedupeSources,
  renderCitation,
  formatCitations,
} from './citation-formatter.js';
