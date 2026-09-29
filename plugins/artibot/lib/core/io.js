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
 * // Block a tool call. To allow, write nothing: legacy 'approve' skips the permission prompt.
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
 * Used by PreToolUse hooks to block operations.
 *
 * Only 'block' is a safe value to pass. To allow, write NOTHING and exit 0: the host
 * reads the legacy `decision:"approve"` as `permissionDecision:"allow"` and skips the
 * permission prompt (PreToolUse on the Bash tool, measured on host 2.1.284; evidence:
 * .artibot/guides/v5-design/evidence/ca04-host-ask-probe.md, section 3.1). The legacy
 * `decision` field takes only `approve` and `block`, so 'info' is not a host value
 * either. This helper forwards `decision` unvalidated and would write 'approve' or
 * 'info' as given; do not pass them. As of 2026-09-29 nothing in lib/ or scripts/
 * calls it (grep of the whole repo: only the lib/core/index.js re-export and tests).
 *
 * @param {'approve'|'block'|'info'} decision - Hook decision type; pass 'block'.
 * @param {string} [reason] - Optional reason for the decision (displayed to user on block).
 * @returns {void}
 * @example
 * // Block a dangerous command
 * writeHookResult('block', 'rm -rf is not allowed in this context');
 */
export function writeHookResult(decision, reason) {
  const result = { decision };
  if (reason) result.reason = reason;
  writeJSON(result);
}
