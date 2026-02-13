/**
 * Conditional debug logging.
 * Active when ARTIBOT_DEBUG=1 environment variable is set.
 * @module lib/core/debug
 */

const isDebug = process.env.ARTIBOT_DEBUG === '1';

/**
 * Log a debug message to stderr (to avoid polluting stdout for hooks).
 * Only outputs when ARTIBOT_DEBUG=1.
 * @param {string} tag - Log category/source
 * @param  {...any} args - Values to log
 */
export function debug(tag, ...args) {
  if (!isDebug) return;
  const timestamp = new Date().toISOString();
  const prefix = `[artibot:${tag}] ${timestamp}`;
  process.stderr.write(`${prefix} ${args.map(formatArg).join(' ')}\n`);
}

/**
 * Create a scoped debug logger.
 * @param {string} tag
 * @returns {function(...any): void}
 */
export function createDebugger(tag) {
  return (...args) => debug(tag, ...args);
}

/** Check if debug mode is active. */
export function isDebugEnabled() {
  return isDebug;
}

function formatArg(arg) {
  if (arg === null || arg === undefined) return String(arg);
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}
