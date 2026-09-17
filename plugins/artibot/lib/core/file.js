/**
 * File system utilities with safe defaults.
 * @module lib/core/file
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * Check if a file or directory exists.
 *
 * @param {string} filePath - Absolute path to check.
 * @returns {Promise<boolean>} `true` if the path exists and is accessible, `false` otherwise.
 * @example
 * if (await exists('/path/to/config.json')) {
 *   const config = await readJsonFile('/path/to/config.json');
 * }
 */
export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON file.
 * Returns `null` if the file does not exist or contains invalid JSON.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @returns {Promise<object|null>} Parsed JSON object, or `null` on failure.
 * @example
 * const config = await readJsonFile('/path/to/artibot.config.json');
 * if (config) {
 *   console.log(config.team.engine);
 * }
 */
export async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write an object as JSON to a file, creating parent directories if needed.
 *
 * Delegates to `atomicWriteJson`, so the write is crash-safe: readers never
 * observe a partial file and a failure leaves the previous content intact.
 * The emitted bytes are unchanged (`JSON.stringify(data, null, indent)` plus a
 * trailing newline), so this is transparent to existing callers.
 *
 * The cost of that atomicity is a new failure mode: the write now ends in a
 * rename, which on Windows can throw EPERM/EBUSY/EACCES when antivirus, the
 * file indexer, or another process momentarily holds the target (see the
 * hardening note at scripts/utils/index.js:102-110). Since 2026-09-15 that
 * rename retries through {@link renameWithRetry} — five attempts with a
 * 10·20·40·80ms backoff — and only propagates to the caller if the lock
 * outlives the ~150ms budget, or if the error is not a transient one.
 *
 * @param {string} filePath - Absolute path to write to.
 * @param {object} data - Data to serialize as JSON.
 * @param {number} [indent=2] - Number of spaces for JSON indentation.
 * @returns {Promise<void>}
 * @example
 * await writeJsonFile('/path/to/output.json', { key: 'value' });
 * await writeJsonFile('/path/to/compact.json', data, 0); // no indentation
 */
export async function writeJsonFile(filePath, data, indent = 2) {
  await atomicWriteJson(filePath, data, indent);
}

/**
 * Build a unique temp sibling path for atomic writes. Includes pid + hrtime +
 * random suffix so concurrent writers in the same process collide only
 * astronomically rarely (avoids the "two writers pick the same ms" race).
 *
 * @param {string} filePath - Target absolute path.
 * @returns {string} Temp sibling path.
 */
function buildAtomicTmpPath(filePath) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${filePath}.tmp.${process.pid}.${Date.now()}.${rand}`;
}

/**
 * Clean up a stray tmp file, swallowing ENOENT. Never throws.
 *
 * @param {string} tmpPath
 * @returns {void}
 */
function cleanupTmpSync(tmpPath) {
  try { fsSync.unlinkSync(tmpPath); } catch { /* best-effort */ }
}

/**
 * Rename errors worth retrying. On Windows `rename` fails with EPERM (or
 * EBUSY/EACCES) when the DESTINATION still has an open handle — antivirus, the
 * search indexer, or another reader that has not closed yet. The condition is
 * transient and clears in tens of milliseconds.
 *
 * Only the destination-exists case is exposed: a rename that CREATES the
 * destination cannot collide with a handle on it. That is why the failure
 * always showed up on a second write, never a first.
 * @type {Set<string>}
 */
export const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Rename attempts before the original error propagates. @type {number} */
export const MAX_RENAME_ATTEMPTS = 5;

/**
 * Synchronous sleep without busy-wait. `Atomics.wait` on a throwaway cell that
 * nothing ever notifies always runs the full timeout, so it yields the thread
 * to the OS scheduler instead of spinning the CPU.
 *
 * @param {number} ms - non-negative milliseconds
 * @returns {void}
 */
export function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `fs.renameSync` with bounded retry on a transient Windows destination lock.
 *
 * Measured (2026-09-15): a two-dispatch `/split` sequence under parallel vitest
 * load refused in 4 of 480 runs (0.83%) with
 * `EPERM: operation not permitted, rename '<dest>.tmp.<pid>.<ts>' -> '<dest>'`,
 * and only ever on the SECOND write. It surfaced at two independent call sites
 * — `lib/git/split-brief.js#atomicWriteBytes` (brief/prompt/addendum) and
 * {@link atomicWriteTextSync} below (`run.json`) — which is why the helper
 * lives here in core rather than being copied a fourth time.
 *
 * Default backoff is 10·20·40·80ms across five attempts (~150ms budget).
 * Anything that is not a transient code throws on the first attempt, so a
 * genuine ENOENT or EXDEV still fails fast. After the final attempt the
 * original error is re-thrown, so every caller's cleanup contract is unchanged.
 *
 * `attempts` and `maxBackoffMs` exist because a caller under heavier FS
 * contention needs a longer but still bounded budget: `session-store.js`
 * passes 8 attempts with each sleep capped at 250ms (~810ms), the shape it
 * was raised to after the S3 flake. The cap only clamps individual sleeps —
 * the doubling itself is unchanged.
 *
 * @param {string} tmp - source temp path
 * @param {string} dest - destination final path
 * @param {object} [opts] - retry budget overrides
 * @param {number} [opts.attempts=MAX_RENAME_ATTEMPTS] - total rename attempts
 *   including the first; the original error is re-thrown after the last.
 * @param {number} [opts.maxBackoffMs=Infinity] - ceiling for a single
 *   inter-attempt sleep, so late attempts cannot block for an unbounded stretch.
 * @returns {void}
 * @example
 * renameWithRetry(tmpPath, '/path/runtime/state.json');
 * @example
 * renameWithRetry(tmpPath, statePath, { attempts: 8, maxBackoffMs: 250 });
 */
export function renameWithRetry(tmp, dest, opts = {}) {
  const { attempts = MAX_RENAME_ATTEMPTS, maxBackoffMs = Infinity } = opts;
  for (let attempt = 1; ; attempt += 1) {
    try {
      fsSync.renameSync(tmp, dest);
      return;
    } catch (err) {
      if (!TRANSIENT_RENAME_CODES.has(err?.code) || attempt >= attempts) throw err;
      sleepSync(Math.min(10 * 2 ** (attempt - 1), maxBackoffMs));
    }
  }
}

/**
 * Atomic text write with temp file + rename. Guaranteed crash-safe: readers
 * never observe a partial file, and a crash mid-write leaves the previous
 * content intact. Creates parent directory first, then writes a unique tmp
 * sibling, then renames into place. If rename fails, the tmp file is removed
 * so we never leak `.tmp.*` droppings.
 *
 * The content is written byte-for-byte as given — no trailing newline is
 * added. Callers that want one must include it, otherwise a read → write
 * round-trip would grow the file on every pass.
 *
 * @param {string} filePath - Absolute path to the text file.
 * @param {string} content - Exact content to write.
 * @returns {Promise<void>}
 * @example
 * await atomicWriteText('/path/skills/foo/SKILL.md', markdown);
 */
export async function atomicWriteText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  const tmp = buildAtomicTmpPath(filePath);
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    cleanupTmpSync(tmp);
    throw err;
  }
}

/**
 * Synchronous variant of `atomicWriteText`. Intended for startup-critical
 * paths (hooks, sync loggers) where an async API would complicate the call
 * site. Identical crash-safety and no-added-newline semantics.
 *
 * @param {string} filePath - Absolute path to the text file.
 * @param {string} content - Exact content to write.
 * @returns {void}
 * @example
 * atomicWriteTextSync('/path/runtime/last-run.log', line);
 */
export function atomicWriteTextSync(filePath, content) {
  ensureDirSync(path.dirname(filePath));
  const tmp = buildAtomicTmpPath(filePath);
  try {
    fsSync.writeFileSync(tmp, content, 'utf-8');
    renameWithRetry(tmp, filePath);
  } catch (err) {
    cleanupTmpSync(tmp);
    throw err;
  }
}

/**
 * Atomic JSON write with temp file + rename. Serializes, appends the
 * conventional trailing newline, and delegates the crash-safe write to
 * `atomicWriteText`.
 *
 * Use this for any JSON state file that must survive crashes / concurrent
 * writes (self-control state, decision trail, kill-switch state, first-run
 * guard, cooldown files, etc).
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {object} data - Data to serialize as JSON.
 * @param {number} [indent=2] - Number of spaces for indentation.
 * @returns {Promise<void>}
 * @example
 * await atomicWriteJson('/path/runtime/state.json', { globalRuns: 3 });
 */
export async function atomicWriteJson(filePath, data, indent = 2) {
  await atomicWriteText(filePath, JSON.stringify(data, null, indent) + '\n');
}

/**
 * Synchronous variant of `atomicWriteJson`. Intended for startup-critical
 * paths (hooks, sync loggers, kill-switch config flip) where an async API
 * would complicate the call site. Identical crash-safety semantics.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {object} data - Data to serialize as JSON.
 * @param {number} [indent=2] - Number of spaces for indentation.
 * @returns {void}
 * @example
 * atomicWriteJsonSync('/path/runtime/decision-trail.json', trail);
 */
export function atomicWriteJsonSync(filePath, data, indent = 2) {
  atomicWriteTextSync(filePath, JSON.stringify(data, null, indent) + '\n');
}

/**
 * Read a file as a UTF-8 string.
 * Returns `null` if the file does not exist.
 *
 * @param {string} filePath - Absolute path to the text file.
 * @returns {Promise<string|null>} File contents as a string, or `null` on failure.
 * @example
 * const content = await readTextFile('/path/to/SKILL.md');
 * if (content) {
 *   console.log(content.length, 'characters');
 * }
 */
export async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 * Catches EEXIST errors that can occur on Windows + OneDrive due to
 * filesystem sync race conditions even with `recursive: true`.
 *
 * @param {string} dirPath - Absolute directory path to create.
 * @returns {Promise<void>}
 * @example
 * await ensureDir('/home/user/.claude/artibot/patterns');
 */
export async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Synchronous version of ensureDir for use in hooks and sync contexts.
 * Catches EEXIST errors from Windows + OneDrive race conditions.
 *
 * @param {string} dirPath - Absolute directory path to create.
 * @returns {void}
 * @example
 * ensureDirSync('/home/user/.claude/artibot/patterns');
 */
export function ensureDirSync(dirPath) {
  try {
    fsSync.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Synchronous read-and-parse of a JSON file with a fallback.
 * Intended for hot, synchronous paths (hooks, middleware) where an async
 * API would complicate the call site. Returns `fallback` when the file is
 * missing, unreadable, or contains invalid JSON.
 *
 * @template T
 * @param {string} filePath - Absolute path to the JSON file.
 * @param {T} [fallback=null] - Value returned on any failure.
 * @returns {object|T} Parsed JSON object, or `fallback` on failure.
 */
export function readJsonFileSync(filePath, fallback = null) {
  try {
    if (!fsSync.existsSync(filePath)) return fallback;
    return JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

/**
 * List files in a directory matching an optional extension filter.
 * Returns an empty array if the directory does not exist.
 *
 * @param {string} dirPath - Absolute path to the directory to scan.
 * @param {string} [ext] - Extension filter (e.g. `'.md'`, `'.js'`).
 * @returns {Promise<string[]>} Array of absolute file paths matching the filter.
 * @example
 * const mdFiles = await listFiles('/path/to/agents', '.md');
 * // ['/path/to/agents/orchestrator.md', '/path/to/agents/architect.md', ...]
 *
 * const allFiles = await listFiles('/path/to/lib/core');
 * // ['/path/to/lib/core/platform.js', '/path/to/lib/core/cache.js', ...]
 */
export async function listFiles(dirPath, ext) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let files = entries
      .filter((e) => e.isFile())
      .map((e) => path.join(dirPath, e.name));
    if (ext) {
      files = files.filter((f) => f.endsWith(ext));
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * List subdirectories in a directory.
 * Returns an empty array if the directory does not exist.
 *
 * @param {string} dirPath - Absolute path to the parent directory.
 * @returns {Promise<string[]>} Array of absolute paths to subdirectories.
 * @example
 * const skillDirs = await listDirs('/path/to/skills');
 * // ['/path/to/skills/orchestration', '/path/to/skills/persona-architect', ...]
 */
export async function listDirs(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dirPath, e.name));
  } catch {
    return [];
  }
}
