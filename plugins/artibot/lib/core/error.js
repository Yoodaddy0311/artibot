/**
 * Unified error logging utility for Artibot.
 * @module lib/core/error
 */

/**
 * Log an error to stderr with consistent formatting.
 * @param {string} context - The module or hook name (e.g., 'pre-bash', 'session-end')
 * @param {string} message - Human-readable error description
 * @param {Error|*} [cause] - Original error object (optional)
 * @returns {void}
 * @example
 * logError('pre-bash', 'Failed to validate command');
 * // stderr: [artibot:pre-bash] Failed to validate command
 *
 * logError('session-end', 'State save failed', new Error('ENOENT'));
 * // stderr: [artibot:session-end] State save failed: ENOENT
 */
export function logError(context, message, cause) {
  const prefix = `[artibot:${context}]`;
  const detail = cause !== null && cause !== undefined ? `: ${cause.message ?? cause}` : '';
  process.stderr.write(`${prefix} ${message}${detail}\n`);
}

/**
 * Wrap an async function with error boundary.
 * Catches errors and logs them, optionally returning a fallback value.
 * @param {string} context - Module name for error logging
 * @param {Function} fn - Async function to wrap
 * @param {*} [fallback] - Value to return on error (default: undefined)
 * @returns {Function} Wrapped function
 * @example
 * const safeLoad = withErrorBoundary('config', loadConfig, {});
 * const config = await safeLoad();
 * // On error: logs to stderr and returns {}
 */
export function withErrorBoundary(context, fn, fallback = undefined) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      logError(context, 'Unhandled error', err);
      return fallback;
    }
  };
}
