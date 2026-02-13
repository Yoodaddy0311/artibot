/**
 * stdin/stdout I/O helpers for hook scripts.
 * @module lib/core/io
 */

/**
 * Read all of stdin and parse as JSON.
 * Returns null if stdin is empty or unparseable.
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
 * Read all of stdin as a string.
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
 * Claude Code hooks expect JSON output.
 * @param {object} data
 */
export function writeJSON(data) {
  process.stdout.write(JSON.stringify(data));
}

/**
 * Write a plain text message to stdout.
 * @param {string} message
 */
export function writeText(message) {
  process.stdout.write(message);
}

/**
 * Write an error response in the Claude Code hook format.
 * @param {string} message
 */
export function writeError(message) {
  writeJSON({ error: message });
}

/**
 * Write a hook result with optional blocking.
 * @param {'approve'|'block'|'info'} decision
 * @param {string} [reason]
 */
export function writeHookResult(decision, reason) {
  const result = { decision };
  if (reason) result.reason = reason;
  writeJSON(result);
}
