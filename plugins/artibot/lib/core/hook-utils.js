/**
 * Common utility functions extracted from hook scripts.
 * Provides reusable patterns for path validation, error logging,
 * and environment checks used across all hooks.
 * @module lib/core/hook-utils
 */

import path from 'node:path';

// -------------------------------------------------------------------------
// Path Validation
// -------------------------------------------------------------------------

/**
 * Check if a file path has one of the specified extensions.
 * @param {string} filePath - File path to check
 * @param {Set<string>|string[]} extensions - Set or array of extensions (with dot, e.g. '.js')
 * @returns {boolean}
 */
export function hasExtension(filePath, extensions) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (extensions instanceof Set) {
    return extensions.has(ext);
  }
  return extensions.includes(ext);
}

/**
 * Extract the lowercase file extension without the dot.
 * Returns null if no extension found.
 * @param {string} [filePath]
 * @returns {string|null}
 */
export function extractExtension(filePath) {
  if (!filePath) return null;
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return ext || null;
}

/**
 * Check if a file path matches any of the given regex patterns.
 * @param {string} filePath - File path to test
 * @param {RegExp[]} patterns - Array of regex patterns
 * @returns {boolean}
 */
export function matchesPathPattern(filePath, patterns) {
  if (!filePath) return false;
  return patterns.some((pattern) => pattern.test(filePath));
}

/**
 * Normalize a file path for cross-platform comparison (forward slashes).
 * @param {string} filePath
 * @returns {string}
 */
export function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

/**
 * Check if a path should be skipped (node_modules, .git, lock files).
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSkippablePath(filePath) {
  const normalized = normalizePath(filePath);
  return (
    normalized.includes('/node_modules/') ||
    normalized.includes('/.git/') ||
    normalized.endsWith('.lock') ||
    normalized.endsWith('-lock.json')
  );
}

// -------------------------------------------------------------------------
// Error Logging
// -------------------------------------------------------------------------

/**
 * Write a formatted error message to stderr with the standard artibot prefix.
 * @param {string} hookName - The hook name (e.g. 'pre-bash', 'session-end')
 * @param {string} message - Human-readable error description
 * @param {Error|*} [cause] - Original error object (optional)
 */
export function logHookError(hookName, message, cause) {
  const detail = cause !== null && cause !== undefined
    ? `: ${cause.message ?? cause}`
    : '';
  process.stderr.write(`[artibot:${hookName}] ${message}${detail}\n`);
}

/**
 * Create a standard hook error handler for use in main().catch().
 * Returns a function that logs the error and optionally exits with code 0.
 * @param {string} hookName - The hook name
 * @param {object} [options]
 * @param {boolean} [options.exit] - Whether to call process.exit(0) after logging (default: false)
 * @param {Function} [options.writeStdout] - If provided, sends a block decision on error
 * @param {string} [options.blockReason] - Reason message when blocking on error
 * @returns {Function} Error handler function
 */
export function createErrorHandler(hookName, options = {}) {
  const { exit = false, writeStdout, blockReason } = options;
  return (err) => {
    logHookError(hookName, err.message || String(err));
    if (writeStdout && blockReason) {
      writeStdout({ decision: 'block', reason: blockReason });
    }
    if (exit) {
      process.exit(0);
    }
  };
}

// -------------------------------------------------------------------------
// Environment Checks
// -------------------------------------------------------------------------

/**
 * Get the user's home directory from environment variables.
 * Checks USERPROFILE (Windows) then HOME (Unix).
 * @returns {string}
 */
export function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || '';
}

/**
 * Get the path to the Claude configuration directory (~/.claude).
 * @returns {string}
 */
export function getClaudeDir() {
  return path.join(getHomeDir(), '.claude');
}

/**
 * Get the path to the artibot data directory (~/.claude/artibot).
 * @returns {string}
 */
export function getArtibotDataDir() {
  return path.join(getClaudeDir(), 'artibot');
}

/**
 * Get the artibot state file path (~/.claude/artibot-state.json).
 * @returns {string}
 */
export function getStatePath() {
  return path.join(getClaudeDir(), 'artibot-state.json');
}

/**
 * Check if a specific environment variable is truthy ('1' or 'true').
 * @param {string} varName - Environment variable name
 * @returns {boolean}
 */
export function isEnvEnabled(varName) {
  const value = process.env[varName];
  return value === '1' || value === 'true';
}

// -------------------------------------------------------------------------
// Hook Input Extraction
// -------------------------------------------------------------------------

/**
 * Extract the file path from hook data's tool_input.
 * Checks both file_path and path fields.
 * @param {object} hookData - Parsed hook data
 * @returns {string}
 */
export function extractFilePath(hookData) {
  return hookData?.tool_input?.file_path || hookData?.tool_input?.path || '';
}

/**
 * Extract the tool name from hook data.
 * @param {object} hookData - Parsed hook data
 * @returns {string}
 */
export function extractToolName(hookData) {
  return hookData?.tool_name || hookData?.tool || '';
}

/**
 * Extract the agent identifier from hook data.
 * Checks agent_id, subagent_id, and name fields.
 * @param {object} hookData - Parsed hook data
 * @returns {string}
 */
export function extractAgentId(hookData) {
  return hookData?.agent_id || hookData?.subagent_id || hookData?.name || 'unknown';
}

/**
 * Extract the agent role from hook data.
 * @param {object} hookData - Parsed hook data
 * @param {string} [defaultRole='teammate'] - Default role if not found
 * @returns {string}
 */
export function extractAgentRole(hookData, defaultRole = 'teammate') {
  return hookData?.role || hookData?.agent_type || defaultRole;
}
