/**
 * Git bridge — read-only subset of git commands exposed to MCP tools.
 *
 * v3.8 scope: **read-only**. Any attempt to dispatch a non-allowlisted
 * subcommand throws before spawning. Write operations (commit, push, reset,
 * rebase, checkout, merge, stash, tag, fetch with --write-fetch-head, etc.)
 * are explicitly rejected. Write support is a v3.9 candidate.
 *
 * Allow-listed commands:
 *   - `git status --porcelain=v1`
 *   - `git log --oneline -10`
 *   - `git branch --list`
 *
 * Design contract:
 *   - Zero runtime deps.
 *   - Uses `execFile` (never `exec`) with a fixed argv — no shell
 *     interpolation, immune to shell metacharacter injection.
 *   - Network-free: the local `cwd` is the only target.
 *   - Korean-path safe; `cwd` is a filesystem path, not a URL.
 *   - Returns `{ok: true, value}` / `{ok: false, error}`.
 *
 * @module lib/mcp/bridge/git-bridge
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Allow-list of fully-formed argv lists. Each entry is the argv **after**
 * the `git` binary. Keys are the bridge-level operation names (stable,
 * exposed via MCP tool dispatch).
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const READONLY_COMMANDS = Object.freeze({
  status: Object.freeze(['status', '--porcelain=v1']),
  log: Object.freeze(['log', '--oneline', '-10']),
  branch: Object.freeze(['branch', '--list']),
});

/**
 * Subcommand allow-set used by `assertReadOnly` — forward-compatible with
 * future safe reads (e.g., `show`, `diff`, `rev-parse`) without changing
 * the write-rejection contract.
 */
const READONLY_SUBCOMMANDS = Object.freeze(new Set([
  'status', 'log', 'branch', 'show', 'diff', 'rev-parse', 'ls-files', 'config',
]));

/**
 * Explicit list of subcommands that write / mutate repo state. Any of these
 * immediately rejects regardless of flags.
 */
const WRITE_SUBCOMMANDS = Object.freeze(new Set([
  'commit', 'push', 'pull', 'fetch', 'reset', 'checkout', 'switch', 'merge',
  'rebase', 'cherry-pick', 'revert', 'stash', 'tag', 'clean', 'gc', 'am',
  'apply', 'clone', 'init', 'mv', 'rm', 'add', 'restore', 'worktree',
  'notes', 'submodule', 'bisect', 'format-patch', 'send-email',
]));

/**
 * Guard — ensures the subcommand is on the allow-list AND not on the
 * write-list. Throws with a stable error message on violation.
 *
 * @param {string} subcommand
 */
function assertReadOnly(subcommand) {
  if (typeof subcommand !== 'string' || subcommand.trim() === '') {
    throw new Error('git-bridge: subcommand required');
  }
  const s = subcommand.trim();
  if (WRITE_SUBCOMMANDS.has(s)) {
    throw new Error(`git-bridge: write operation '${s}' is forbidden (read-only in v3.8)`);
  }
  if (!READONLY_SUBCOMMANDS.has(s)) {
    throw new Error(`git-bridge: subcommand '${s}' is not allow-listed`);
  }
}

/**
 * Execute an allow-listed argv list. Captures stdout/stderr; enforces a
 * 15 s timeout and a 1 MB buffer ceiling so a misbehaving repo cannot hang
 * the MCP server.
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function runGit(argv, cwd) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('git-bridge: argv required');
  }
  assertReadOnly(argv[0]);
  try {
    const { stdout, stderr } = await execFileAsync('git', argv, {
      cwd,
      timeout: 15_000,
      maxBuffer: 1_000_000,
      windowsHide: true,
    });
    return { stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git-bridge: ${argv.join(' ')} failed: ${msg}`, { cause: err });
  }
}

/**
 * Parse porcelain v1 output into `{path, code}` entries.
 * @param {string} out
 * @returns {Array<{path: string, code: string}>}
 */
function parsePorcelain(out) {
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean).map((line) => ({
    code: line.slice(0, 2),
    path: line.slice(3),
  }));
}

/**
 * Parse `git log --oneline -10` into `{sha, subject}` entries.
 * @param {string} out
 * @returns {Array<{sha: string, subject: string}>}
 */
function parseOneline(out) {
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const idx = line.indexOf(' ');
    if (idx === -1) return { sha: line, subject: '' };
    return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
  });
}

/**
 * Parse `git branch --list` into `{name, current}` entries.
 * @param {string} out
 * @returns {Array<{name: string, current: boolean}>}
 */
function parseBranches(out) {
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const current = line.startsWith('*');
    const name = line.replace(/^\*?\s+/, '').trim();
    return { name, current };
  });
}

/**
 * Create a git bridge scoped to a cwd.
 *
 * @param {object} [deps]
 * @param {string} [deps.cwd]              - Working directory (default: `process.cwd()`)
 * @param {(argv: string[], cwd: string) => Promise<{stdout: string, stderr: string}>} [deps.exec]
 *   Test seam — override the underlying git runner.
 *
 * @returns {{
 *   status: () => Promise<{ok: boolean, value?: object, error?: string}>,
 *   log:    () => Promise<{ok: boolean, value?: object, error?: string}>,
 *   branches: () => Promise<{ok: boolean, value?: object, error?: string}>,
 *   run:    (name: keyof typeof READONLY_COMMANDS) => Promise<{ok: boolean, value?: object, error?: string}>,
 * }}
 */
export function createGitBridge(deps = {}) {
  const cwd = typeof deps.cwd === 'string' && deps.cwd.trim() !== ''
    ? deps.cwd
    : process.cwd();
  const exec = typeof deps.exec === 'function' ? deps.exec : runGit;

  async function status() {
    try {
      const { stdout } = await exec([...READONLY_COMMANDS.status], cwd);
      return { ok: true, value: { entries: parsePorcelain(stdout), clean: stdout.trim() === '' } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function log() {
    try {
      const { stdout } = await exec([...READONLY_COMMANDS.log], cwd);
      return { ok: true, value: { commits: parseOneline(stdout) } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function branches() {
    try {
      const { stdout } = await exec([...READONLY_COMMANDS.branch], cwd);
      return { ok: true, value: { branches: parseBranches(stdout) } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function run(name) {
    if (!Object.prototype.hasOwnProperty.call(READONLY_COMMANDS, name)) {
      return { ok: false, error: `unknown op: ${name}` };
    }
    if (name === 'status') return status();
    if (name === 'log') return log();
    if (name === 'branch') return branches();
    return { ok: false, error: `unknown op: ${name}` };
  }

  return Object.freeze({ status, log, branches, run });
}

// Exported for tests.
export const __test__ = Object.freeze({
  READONLY_COMMANDS,
  READONLY_SUBCOMMANDS,
  WRITE_SUBCOMMANDS,
  assertReadOnly,
  parsePorcelain,
  parseOneline,
  parseBranches,
});
