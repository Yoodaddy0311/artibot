/**
 * Common utility functions extracted from hook scripts.
 * Provides reusable patterns for path validation, error logging,
 * and environment checks used across all hooks.
 * @module lib/core/hook-utils
 */

import path from 'node:path';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { getHomeDir, normalizeDirPath } from './platform.js';

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
 * Get the user's home directory. Re-exported from platform.js to keep a single
 * source of truth for home resolution. platform.getHomeDir falls back to
 * os.homedir() when neither USERPROFILE nor HOME is set, so env-stripped hook
 * spawns never yield a relative `.claude` path (the empty-string fallback this
 * replaces). Checks USERPROFILE (Windows) then HOME (Unix) then os.homedir().
 * @returns {string}
 */
export { getHomeDir };

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

/**
 * Detect whether the given directory is the Artibot plugin repo itself.
 *
 * Artibot installs globally to `~/.claude/`, so its hooks fire in every
 * Claude Code session — including unrelated user projects. Hooks that
 * enforce Artibot-specific policy (DEV verify, review-gate quality rules,
 * TDD mirror suggestions, etc.) must gate on this helper to avoid
 * false-positive noise outside the plugin repo.
 *
 * Detection signals (any one is sufficient):
 *   - `plugins/artibot/CLAUDE.md`        → working from the Artibot monorepo root
 *   - `artibot.config.json` at cwd       → working inside the plugin directory
 *
 * This is the source-of-truth replacing the previously-duplicated
 * implementations in `dev-verify-gate.js` and `stop-review-gate.js`.
 *
 * @param {string} [cwd] - Directory to check. When the argument is omitted
 *   entirely, falls back to `process.cwd()`. A falsy value passed
 *   explicitly (e.g. `''` or `null`) returns `false` defensively, matching
 *   the contract callers like the post-write-tdd hook depend on.
 * @returns {boolean}
 */
export function isArtibotRepo(cwd) {
  const raw = arguments.length === 0 ? process.cwd() : cwd;
  if (!raw) return false;
  // Normalized first: a caller that got its cwd from a Git Bash-launched
  // process spells it `/c/Users/x`, which Node cannot stat, so both markers
  // read as absent for the repo itself. Measured 2026-08-30 — that dropped the
  // `artibot-policy` guards (`sensitive-file`, `content-secret`) for an
  // otherwise ordinary write inside this repo.
  const dir = normalizeDirPath(raw);
  if (!dir) return false;
  return (
    existsSync(path.join(dir, 'plugins', 'artibot', 'CLAUDE.md')) ||
    existsSync(path.join(dir, 'artibot.config.json'))
  );
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
 * Extract the tool name from a hook payload.
 *
 * Single source of truth as of v4.8.0 (H-2). Previously duplicated in
 * `scripts/hooks/_dispatcher-utils.js` with divergent key ordering — that
 * file now re-exports this implementation.
 *
 * Recognized keys (in priority order):
 *   - `tool_name` (snake_case, canonical Claude Code payload key)
 *   - `tool` (legacy short form)
 *   - `toolName` (camelCase variant)
 *   - `toolUse.name` / `tool_use.name` (nested ToolUse envelope)
 *
 * Returns null when nothing matches or input is not an object, so callers
 * can safely use truthy checks or `=== 'Bash'`-style equality.
 *
 * @param {object} hookData - Parsed hook data
 * @returns {string|null}
 */
export function extractToolName(hookData) {
  if (!hookData || typeof hookData !== 'object') return null;
  return (
    hookData.tool_name ||
    hookData.tool ||
    hookData.toolName ||
    hookData.toolUse?.name ||
    hookData.tool_use?.name ||
    null
  );
}

/**
 * The user's prompt text from a **UserPromptSubmit** payload.
 *
 * SINGLE SOURCE OF TRUTH for that one key question. Six call sites used to
 * answer it independently and five of them answered it wrong, which is how the
 * whole UserPromptSubmit chain ran dead for a release while the sixth
 * (`ambiguity-guard`) kept working and hid the outage.
 *
 * MEASURED 2026-09-03 against the Claude Code **2.1.259** binary
 * (`~/.local/share/claude/versions/2.1.259`, Zod hook-input schema table at
 * byte offset ~183,955,500). UserPromptSubmit is
 *   base.and({ hook_event_name: 'UserPromptSubmit', prompt, source?, session_title? })
 * where base = { session_id, transcript_path, cwd, prompt_id?,
 * permission_mode?, agent_id?, agent_type?, effort? }.
 * The host's key is therefore **`prompt`** — that payload carries no
 * `user_prompt`, `userPrompt`, `content`, `message` or `text`.
 *
 * The three keys checked here, and why each one is checked:
 *   1. `user_prompt` — NOT a host key. `_userprompt-dispatcher.js` writes it
 *      onto the payload after `user-prompt-handler` rewrites the prompt, so
 *      the parallel contributors classify the text that will actually run. It
 *      is checked FIRST for that reason, and with a typeof-string test rather
 *      than a truthy one: `''` is a legitimate rewriter output ("blank this
 *      out") and a `||` chain would silently fall back to the original.
 *   2. `prompt` — the host key, measured above.
 *   3. `content` — pre-existing legacy fallback, kept so this change cannot
 *      regress a caller that already relied on it. No 2.1.259 payload carries
 *      it; it should be removable once that is confirmed.
 *
 * NOT a general "prompt text" getter. SubagentStart carries no free text at
 * all (see `scripts/hooks/subagent-handler.js#extractActionText`), so there is
 * nothing there for this to unify with.
 *
 * @param {*} hookData - Parsed UserPromptSubmit payload
 * @returns {string} The prompt text, or `''` when the payload names none
 */
export function extractUserPromptText(hookData) {
  if (!hookData || typeof hookData !== 'object') return '';
  for (const key of ['user_prompt', 'prompt', 'content']) {
    const value = hookData[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * Every prompt spelling in the payload, joined — the surface an OPT-OUT FLAG
 * must be searched on. Use `extractUserPromptText` to CLASSIFY, and this to
 * decide whether the user asked to be left alone.
 *
 * WHY THESE ARE TWO FUNCTIONS. `user-prompt-handler` STRIPS `--no-team` from
 * the prompt and the dispatcher then puts that stripped text on
 * `payload.user_prompt`, which `extractUserPromptText` returns first. A hook
 * that tests its opt-out regex against that value therefore never sees the
 * flag the user typed, and fires anyway — the opt-out silently stops working.
 * The flag is on `payload.prompt` (the untouched host key) the whole time.
 *
 * The union is deliberate, and it is NOT the same as "read the original":
 *   - original only  → misses a flag that reaches a hook on `user_prompt`
 *     alone, e.g. a direct handler call with no rewriter in front of it.
 *   - union          → any spelling that carries the flag disables the
 *     feature. An opt-out is a stated user intent; once expressed it must not
 *     be erasable by a downstream rewrite. Fail CLOSED, never fail open.
 *
 * Joined with a newline so `\b` anchors cannot fuse the tail of one value to
 * the head of the next and invent a match that is in neither.
 *
 * @param {*} hookData - Parsed UserPromptSubmit payload
 * @returns {string} All prompt spellings, newline-joined; `''` when none
 */
export function extractUserPromptFlagSurface(hookData) {
  if (!hookData || typeof hookData !== 'object') return '';
  const seen = [];
  for (const key of ['user_prompt', 'prompt', 'content']) {
    const value = hookData[key];
    if (typeof value === 'string' && value !== '' && !seen.includes(value)) {
      seen.push(value);
    }
  }
  return seen.join('\n');
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

// -------------------------------------------------------------------------
// State File Tmp Cleanup
// -------------------------------------------------------------------------

// Tmp files older than this are considered orphans from crashed/killed processes.
const STALE_TMP_AGE_MS = 60 * 1000; // 1 minute

/**
 * Best-effort cleanup of orphan `<statePath>.tmp.<pid>` files left behind
 * by crashed hook processes or Windows EPERM/EBUSY rename failures.
 *
 * Only removes tmp files older than {@link STALE_TMP_AGE_MS} AND owned by a
 * different PID than the current process, so concurrent in-flight writers
 * (including this very process's atomicWriteSync mid-operation) are not
 * disturbed. All errors are swallowed — this is a hygienic best-effort path
 * that must never break a hook.
 *
 * @param {string} statePath - Absolute path of the state file (e.g. ~/.claude/artibot-state.json)
 * @returns {number} Number of stale tmp files removed
 */
export function cleanupStaleStateTmpFiles(statePath) {
  if (!statePath) return 0;
  const dir = path.dirname(statePath);
  const base = path.basename(statePath) + '.tmp.';
  const cutoff = Date.now() - STALE_TMP_AGE_MS;
  const selfPid = process.pid;
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(base)) continue;
    // Extract <pid> suffix; skip our own tmp files to avoid racing in-flight writes.
    const filePid = Number.parseInt(name.slice(base.length), 10);
    if (Number.isFinite(filePid) && filePid === selfPid) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs > cutoff) continue; // still in flight, leave alone
      unlinkSync(full);
      removed++;
    } catch {
      // file vanished mid-loop or is locked by another process — ignore
    }
  }
  return removed;
}
