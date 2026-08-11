/**
 * Shared dispatcher utilities.
 *
 * Each Artibot dispatcher (UserPromptSubmit/SessionStart/PostToolUse/Stop/
 * SessionEnd) consolidates N hooks-per-slot into a single registered command.
 *
 * Design contract:
 *
 *   1. Every hook is invoked as a child Node process. This isolates crashes —
 *      one hook's SyntaxError or unhandled rejection never propagates into the
 *      dispatcher process and never blocks the slot.
 *   2. Each child has its own timeout. The dispatcher SIGTERMs and resolves
 *      with `{ status: 'timeout', name }` so a slow hook never holds up the
 *      slot.
 *   3. stdout JSON from each child is parsed best-effort. Garbage stdout
 *      simply contributes nothing to the merge.
 *   4. stderr from each child is forwarded to the parent process's stderr
 *      so existing observability (banners, advisories, [artibot:*] markers)
 *      survives consolidation.
 *   5. NEVER throw and NEVER exit non-zero. Hook crashes must not block the
 *      slot.
 *
 * @module scripts/hooks/_dispatcher-utils
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extractToolName } from '../../lib/core/hook-utils.js';
import { isMainEntry } from './_main-entry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// isMainEntry is owned by ./_main-entry.js — a zero-dependency leaf module, so
// the ~50 hooks that need only the direct-run guard do not pull this file's
// child_process + hook-utils graph onto the spawn hot path. Re-exported here so
// the dispatchers (and tests) that already import it from this module are
// unaffected.
export { isMainEntry };

// v4.8.0 H-2: extractToolName is owned by lib/core/hook-utils.js; we re-export
// it so the dispatcher hot path keeps a single import line and downstream
// callers (_posttooluse-dispatcher.js, tests) see one canonical implementation.
export { extractToolName };

/**
 * Read the entire stdin payload and JSON-parse it. Returns {} on empty/invalid.
 * @returns {Promise<object>}
 */
export async function readPayload() {
  let buf = '';
  try {
    for await (const chunk of process.stdin) buf += chunk;
  } catch {
    return {};
  }
  if (!buf) return {};
  try {
    return JSON.parse(buf);
  } catch {
    return {};
  }
}

/**
 * Resolve a hook script path relative to scripts/hooks/.
 * @param {string} name e.g. "session-start.js"
 * @returns {string}
 */
export function hookPath(name) {
  return path.join(HERE, name);
}

/**
 * Spawn a hook child process with the given payload on stdin.
 *
 * Resolution is guaranteed:
 *   - on natural exit (whatever the exit code),
 *   - on hard timeout (SIGTERM then resolve),
 *   - on spawn error (resolve with status=error),
 *   - never rejects.
 *
 * @param {string} scriptPath absolute path to the hook script
 * @param {object} payload JSON-serializable input
 * @param {object} opts
 * @param {number} opts.timeoutMs hard timeout per hook (default 5000)
 * @param {string} opts.name human-readable hook name for logs
 * @param {string[]} [opts.args] extra CLI arguments to pass after the script
 * @param {string} [opts.dispatcherName] dispatcher tag for stderr lines
 * @returns {Promise<{ status: 'ok'|'timeout'|'error', name: string, stdout: string }>}
 */
export function spawnHook(scriptPath, payload, opts) {
  const {
    timeoutMs = 5000,
    name = path.basename(scriptPath, '.js'),
    args = [],
    dispatcherName = '_dispatcher',
  } = opts || {};

  return new Promise((resolve) => {
    let settled = false;
    const chunks = [];

    function finish(status) {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(chunks).toString('utf-8');
      resolve({ status, name, stdout });
    }

    let child;
    try {
      child = spawn(process.execPath, [scriptPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env },
      });
    } catch (err) {
      process.stderr.write(`[artibot:${dispatcherName}] ${name} spawn failed: ${err.message}\n`);
      finish('error');
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      process.stderr.write(`[artibot:${dispatcherName}] ${name} timed out after ${timeoutMs}ms\n`);
      finish('timeout');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      process.stderr.write(`[artibot:${dispatcherName}] ${name} error: ${err.message}\n`);
      finish('error');
    });
    child.on('exit', () => {
      clearTimeout(timer);
      finish('ok');
    });

    if (child.stdout) {
      child.stdout.on('data', (c) => chunks.push(c));
    }
    // Forward child stderr lines to parent stderr so banners / advisories
    // remain visible after consolidation.
    if (child.stderr) {
      child.stderr.on('data', (c) => {
        try { process.stderr.write(c); } catch { /* ignore */ }
      });
    }

    try {
      child.stdin.end(JSON.stringify(payload || {}));
    } catch (err) {
      process.stderr.write(`[artibot:${dispatcherName}] ${name} stdin write failed: ${err.message}\n`);
      // Let exit/timeout handlers complete the promise.
    }
  });
}

/**
 * Parse a hook's stdout best-effort. Returns null when empty / unparseable
 * (we never throw on bad stdout — a hook is allowed to print nothing).
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseHookStdout(stdout) {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Merge an array of hook results into a single response envelope.
 *
 *   - `additionalContext` from every hookSpecificOutput is concatenated with
 *     blank-line separators (in array order).
 *   - `decision === 'block'` from any hook wins (we surface the first blocker
 *     with its reason); we still concat any additionalContext from later
 *     hooks for visibility.
 *   - `message` strings are joined with newline separators.
 *   - Other top-level fields are shallow-merged (last write wins).
 *
 * @param {Array<object|null>} results
 * @param {string} hookEventName for the merged hookSpecificOutput envelope
 * @returns {object|null}
 */
export function mergeResults(results, hookEventName) {
  const out = {};
  const additions = [];
  const messages = [];
  let blocker = null;

  for (const r of results || []) {
    if (!r || typeof r !== 'object') continue;
    if (Array.isArray(r)) continue;

    const ctx = r?.hookSpecificOutput?.additionalContext;
    if (typeof ctx === 'string' && ctx.length > 0) additions.push(ctx);

    if (typeof r.message === 'string' && r.message.length > 0) {
      messages.push(r.message);
    }

    if (r.decision === 'block' && !blocker) {
      blocker = { decision: 'block', reason: r.reason || 'blocked by hook' };
    }

    for (const [key, val] of Object.entries(r)) {
      if (key === 'hookSpecificOutput') continue;
      if (key === 'message') continue;
      if (key === 'decision' || key === 'reason') continue;
      out[key] = val;
    }
  }

  if (blocker) {
    out.decision = blocker.decision;
    out.reason = blocker.reason;
  }

  if (messages.length > 0) {
    out.message = messages.join('\n');
  }

  if (additions.length > 0) {
    out.hookSpecificOutput = {
      hookEventName,
      additionalContext: additions.join('\n\n'),
    };
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build the fatal handler every dispatcher attaches to `main().catch(...)`.
 *
 * Contract (design note 5 in the module header): a dispatcher must NEVER throw
 * and NEVER exit non-zero — that would block the whole slot. So the handler
 * reports on stderr, where the parent already forwards `[artibot:*]` markers,
 * and then exits 0.
 *
 * Deliberately NOT `hook-utils.createErrorHandler(name, { exit: true })`: that
 * one logs `[artibot:<name>] <message>` while dispatchers log
 * `[artibot:<name>] fatal: <message>`. The `fatal:` marker distinguishes a dead
 * dispatcher (every hook in the slot lost) from a single hook reporting an
 * error, so it is load-bearing in logs rather than cosmetic.
 *
 * @param {string} hookName Dispatcher name, e.g. "posttooluse-dispatcher"
 * @returns {(err: Error) => void}
 */
export function createFatalHandler(hookName) {
  return (err) => {
    process.stderr.write(`[artibot:${hookName}] fatal: ${err.message}\n`);
    process.exit(0);
  };
}
