/**
 * stdin/stdout I/O helpers for hook scripts.
 * @module lib/core/io
 */

/**
 * Read all of stdin and parse as JSON.
 * Returns `null` if stdin is empty or contains unparseable content.
 * Used by hook scripts to receive event data from Claude Code.
 *
 * @returns {Promise<object|null>} Parsed JSON object from stdin, or `null` on failure.
 * @example
 * // In a hook script:
 * const event = await readStdinJSON();
 * if (event?.tool_name === 'Bash') {
 *   // handle bash tool event
 * }
 */
export async function readStdinJSON() {
  const raw = await readStdin();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read all of stdin as a raw UTF-8 string.
 *
 * @returns {Promise<string>} Complete stdin content as a string.
 * @example
 * const raw = await readStdin();
 * console.log('Received', raw.length, 'characters from stdin');
 */
export function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    // If stdin is already ended or not a TTY, handle gracefully
    process.stdin.resume();
  });
}

/**
 * Write a JSON response to stdout.
 * Claude Code hooks expect JSON output for decisions and data.
 *
 * @param {object} data - Object to serialize and write to stdout.
 * @returns {void}
 * @example
 * writeJSON({ decision: 'approve' });
 * writeJSON({ decision: 'block', reason: 'Destructive command detected' });
 */
export function writeJSON(data) {
  process.stdout.write(JSON.stringify(data));
}

/**
 * Write a plain text message to stdout.
 *
 * @param {string} message - Text message to write.
 * @returns {void}
 * @example
 * writeText('Processing complete.');
 */
export function writeText(message) {
  process.stdout.write(message);
}

/**
 * Write an error response in the Claude Code hook format.
 * Outputs `{ "error": "<message>" }` to stdout.
 *
 * @param {string} message - Error message to report.
 * @returns {void}
 * @example
 * writeError('Invalid configuration detected');
 * // outputs: {"error":"Invalid configuration detected"}
 */
export function writeError(message) {
  writeJSON({ error: message });
}

/**
 * Write a hook result with optional blocking.
 * Used by PreToolUse hooks to approve or block operations.
 *
 * @param {'approve'|'block'|'info'} decision - Hook decision type.
 * @param {string} [reason] - Optional reason for the decision (displayed to user on block).
 * @returns {void}
 * @example
 * // Approve an operation
 * writeHookResult('approve');
 *
 * // Block a dangerous command
 * writeHookResult('block', 'rm -rf is not allowed in this context');
 *
 * // Informational note
 * writeHookResult('info', 'Consider running tests after this edit');
 */
export function writeHookResult(decision, reason) {
  const result = { decision };
  if (reason) result.reason = reason;
  writeJSON(result);
}
