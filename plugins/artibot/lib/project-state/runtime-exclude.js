/**
 * Managed `.artibot` runtime block for the git COMMON dir's `info/exclude`.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Artibot hooks create local-only files inside the USER's project:
 * `.artibot/state.yaml` (the state-store projection), `.artibot/runtime/` (event
 * ledger, decisions), `.artibot/ledger/` and `.artibot/transcripts/` (verbatim
 * conversation text), `.artibot/SESSION-NOTES.md`, `.artibot/HANDOFF.md`, … This
 * repository's own root `.gitignore` ignores them. A project that merely
 * installed the plugin has no such rule, so `git add .` commits them — private
 * conversation text included.
 *
 * ── Why `info/exclude`, in the COMMON dir ─────────────────────────────────
 * The project's `.gitignore` is the user's tracked file: editing it dirties
 * their tree and ships our paths to their teammates. `<common dir>/info/exclude`
 * is per-clone, untracked, and — unlike the per-worktree git dir — shared by
 * every linked worktree, so one block covers the main checkout and every
 * `/split` window (measured 2026-09-30, git 2.54.0.windows.1: a block written
 * once into the main repo's `info/exclude` ignored `.artibot/...` in the main
 * checkout and in a linked worktree alike, and left `.artibot/project.md`
 * visible).
 *
 * ── Why no `git` subprocess on the normal path ────────────────────────────
 * This runs on every SessionStart. `git rev-parse --git-common-dir` measured
 * 84-260 ms here (median ~110 ms, n=15) and `lib/git/project-root.js` records
 * 181-270 ms cold for the same class of call. The common dir is two file reads
 * away: the nearest ancestor holding a `.git` entry, then
 * `./git-common-dir.js#resolveGitCommonDir` — the SAME resolution the state
 * store and the ledger bind to, so the exclude lands in the repository they
 * write for. Git stays the authority where a marker cannot see: when `GIT_DIR`,
 * `GIT_COMMON_DIR` or `GIT_WORK_TREE` redirect discovery, `rev-parse` decides
 * (the same tiering `resolveProjectRoot` uses). A directory with no repository
 * above it spawns nothing and is a no-op.
 *
 * ── What the block is ─────────────────────────────────────────────────────
 * `# >>> artibot runtime >>>` … `# <<< artibot runtime <<<`. Everything inside
 * is ours and is REPLACED when it differs; every byte outside is preserved
 * exactly (CRLF included). Every pattern starts with the any-depth prefix
 * (double star, then slash) because the hooks' project root is not always the
 * repository root — a nested cwd is a measured case, see the `.gitignore` note on
 * `.artibot/ledger/` — and that prefix also matches the top level.
 *
 * Canonical files — `.artibot/missions/`, `.artibot/adr/`, `.artibot/project.md`
 * — are NOT in the block: they are meant to be tracked.
 *
 * ── What it does not do ───────────────────────────────────────────────────
 *   - It cannot untrack a file the project already committed.
 *   - A block whose markers are unbalanced (a begin with no end, a stray end,
 *     nesting) is left alone and reported: without both boundaries there is no
 *     way to promise that nothing outside the block is touched.
 *   - It never creates a git directory. The common dir must already exist and
 *     hold a `HEAD`, so a worktree whose main repository was deleted does not
 *     get a phantom `.git/info/exclude` made for it.
 *   - It never writes through a symlinked `info/exclude`. The link is project
 *     input: following it would write wherever it points, replacing it would
 *     break the user's setup. It is reported (`symlinked-exclude`) and left
 *     alone. A linked `info` DIRECTORY is fine — the file inside is an ordinary
 *     file and only a file named `exclude` is ever touched there.
 *
 * Layer: L2. Imports `lib/core` and a sibling only.
 *
 * @module lib/project-state/runtime-exclude
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteTextSync } from '../core/file.js';
import { resolveGitCommonDir } from './git-common-dir.js';

/** First line of the managed block. */
export const BLOCK_BEGIN = '# >>> artibot runtime >>>';

/** Last line of the managed block. */
export const BLOCK_END = '# <<< artibot runtime <<<';

/**
 * The `.artibot` runtime entries — the ones this repository's root `.gitignore`
 * ignores (`tests/firewall/runtime-exclude-drift.test.js` compares the two sets,
 * so neither can change alone). Each is local-only or regenerable; none is
 * canonical.
 *
 * @type {ReadonlyArray<string>}
 */
export const RUNTIME_EXCLUDE_ENTRIES = Object.freeze([
  '**/.artibot/state.yaml',
  '**/.artibot/runtime/',
  '**/.artibot/ledger/',
  '**/.artibot/transcripts/',
  '**/.artibot/generated/',
  '**/.artibot/SESSION-NOTES.md',
  '**/.artibot/HANDOFF.md',
  '**/.artibot/handoffs/',
  '**/.artibot/split/',
  '**/.artibot/scorecard.json',
  '**/.artibot/media/',
]);

/** Comment lines inside the block, so a reader of `info/exclude` knows whose it is. */
const BLOCK_COMMENTS = Object.freeze([
  '# Managed by the Artibot plugin (SessionStart project-bootstrap). Edits inside this block are overwritten.',
  '# Opt out: artibot.config.json projectBootstrap.gitExclude=false, or env ARTIBOT_PROJECT_BOOTSTRAP=off.',
]);

/** Environment variables that redirect git's own repository discovery. */
const GIT_DISCOVERY_OVERRIDES = Object.freeze(['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE']);

/** Budget for the one `git rev-parse` fallback call. */
const GIT_TIMEOUT_MS = 2000;

/**
 * Render the managed block, markers included, without a trailing line break.
 *
 * @param {ReadonlyArray<string>} [entries] - Patterns to emit.
 * @param {string} [eol] - Line terminator to join with.
 * @returns {string} The block text.
 */
export function renderManagedBlock(entries = RUNTIME_EXCLUDE_ENTRIES, eol = '\n') {
  return [BLOCK_BEGIN, ...BLOCK_COMMENTS, ...entries, BLOCK_END].join(eol);
}

/**
 * Split text into lines while remembering where each one sits, so a replacement
 * can splice exact byte ranges and leave everything else untouched.
 *
 * @param {string} text - File content.
 * @returns {Array<{start: number, contentEnd: number, end: number, content: string, terminator: string}>}
 *   `start`..`contentEnd` is the line without its terminator, `end` is the offset
 *   after the terminator. A file ending in a line break yields a final empty line.
 */
function scanLines(text) {
  const lines = [];
  let pos = 0;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl + 1;
    let contentEnd = nl === -1 ? text.length : nl;
    if (contentEnd > pos && text[contentEnd - 1] === '\r') contentEnd -= 1;
    lines.push({
      start: pos,
      contentEnd,
      end,
      content: text.slice(pos, contentEnd),
      terminator: text.slice(contentEnd, end),
    });
    if (nl === -1) return lines;
    pos = end;
  }
}

/**
 * Find every managed block as a begin/end line pair.
 *
 * @param {ReturnType<typeof scanLines>} lines - Scanned file.
 * @returns {Array<{begin: number, end: number}>|null} Line-index pairs, or
 *   `null` when the markers are unbalanced (unterminated, stray, or nested).
 */
function locateBlocks(lines) {
  const blocks = [];
  let open = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const marker = lines[i].content.trimEnd();
    if (marker === BLOCK_BEGIN) {
      if (open !== -1) return null;
      open = i;
    } else if (marker === BLOCK_END) {
      if (open === -1) return null;
      blocks.push({ begin: open, end: i });
      open = -1;
    }
  }
  return open === -1 ? blocks : null;
}

/**
 * Append a block after existing content: finish the last line, leave one blank
 * line, then the block and a closing line break.
 *
 * @param {string} source - Existing content (may be empty).
 * @param {string} block - Rendered block, no trailing line break.
 * @param {string} eol - Line terminator in use.
 * @returns {string} Content with the block appended.
 */
function appendBlock(source, block, eol) {
  if (source === '') return block + eol;
  let head = source;
  if (!head.endsWith('\n')) head += eol;
  if (!head.endsWith('\n\n') && !head.endsWith('\n\r\n')) head += eol;
  return head + block + eol;
}

/**
 * Put the managed block into `text` — pure, no I/O.
 *
 * - no block yet   -> appended (`inserted`)
 * - block differs  -> replaced in place (`replaced`); every managed block found
 *                     is brought up to date, none is deleted
 * - block matches  -> `unchanged`, and `text` is returned byte for byte
 * - markers broken -> `malformed`, `text` returned untouched
 *
 * Bytes outside the markers are never rewritten, including the terminator that
 * follows the end marker. A CRLF file keeps CRLF.
 *
 * @param {string} text - Current `info/exclude` content ('' when absent).
 * @param {ReadonlyArray<string>} [entries] - Patterns the block must hold.
 * @returns {{text: string, action: 'inserted'|'replaced'|'unchanged'|'malformed'}}
 */
export function applyManagedBlock(text, entries = RUNTIME_EXCLUDE_ENTRIES) {
  const source = typeof text === 'string' ? text : '';
  const lines = scanLines(source);
  const blocks = locateBlocks(lines);
  if (blocks === null) return { text: source, action: 'malformed' };

  if (blocks.length === 0) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    return { text: appendBlock(source, renderManagedBlock(entries, eol), eol), action: 'inserted' };
  }

  // Last block first: a replacement only moves offsets that sit after it, so
  // the offsets of the blocks still to do stay valid.
  let next = source;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const { begin, end } = blocks[i];
    const eol = lines[begin].terminator || '\n';
    next = next.slice(0, lines[begin].start)
      + renderManagedBlock(entries, eol)
      + next.slice(lines[end].contentEnd);
  }
  return { text: next, action: next === source ? 'unchanged' : 'replaced' };
}

/** The nearest directory at or above `start` that holds a `.git` entry, or null. */
function nearestRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when `dir` looks like a git directory that exists (holds a `HEAD` file). */
function isGitDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'HEAD')).isFile();
  } catch {
    return false;
  }
}

/** Default git runner for the fallback: `git <args>` in `options.cwd`, stdout as text. */
function runGit(args, options) {
  return execFileSync('git', args, {
    ...options,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Ask git for the common dir; `null` when git is absent, fails, or says nothing. */
function commonDirViaGit(cwd, env, execGit) {
  try {
    const out = execGit(['rev-parse', '--git-common-dir'], { cwd, env });
    const first = String(out).split(/\r?\n/, 1)[0].trim();
    // git prints a path relative to cwd in a main checkout and an absolute one
    // in a linked worktree (measured 2026-09-30); resolve handles both.
    return first === '' ? null : path.resolve(cwd, first);
  } catch {
    return null;
  }
}

/** The common dir from two file reads: nearest `.git` ancestor, then its pointer. */
function commonDirViaMarker(cwd) {
  const root = nearestRepoRoot(cwd);
  return root === null ? null : resolveGitCommonDir(root);
}

/**
 * Resolve the git common directory for `cwd`, or `null` when there is none.
 *
 * Normal path: two file reads, no process. When `GIT_DIR`, `GIT_COMMON_DIR` or
 * `GIT_WORK_TREE` is set, discovery is git's to decide and `git rev-parse` is
 * asked instead. Either way the answer must be an existing git directory.
 *
 * @param {string} cwd - Directory to resolve from (any depth inside the repo).
 * @param {object} [opts] - Injection points.
 * @param {NodeJS.ProcessEnv} [opts.env] - Environment to read; defaults to `process.env`.
 * @param {(args: string[], options: object) => string} [opts.execGit] - Git runner (test seam).
 * @returns {string|null} Absolute common dir, or `null` (not a repository).
 */
export function resolveCommonDir(cwd, { env = process.env, execGit = runGit } = {}) {
  if (typeof cwd !== 'string' || cwd === '') return null;

  const redirected = GIT_DISCOVERY_OVERRIDES.some((key) => typeof env?.[key] === 'string' && env[key] !== '');
  const common = redirected ? commonDirViaGit(cwd, env, execGit) : commonDirViaMarker(cwd);
  return common !== null && isGitDir(common) ? common : null;
}

/**
 * True when `file` is itself a symbolic link. A missing or unreadable path is not.
 *
 * `info/exclude` lives inside the project, so a link there is input the project
 * controls. Writing through it would land wherever it points (any file the user
 * can write), and a rename over it would silently replace the user's link. So it
 * is refused, and left exactly as it is.
 *
 * @param {string} file - `<common dir>/info/exclude`.
 * @returns {boolean} Whether `file` is a link.
 */
function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Make sure `<git common dir>/info/exclude` carries the managed runtime block.
 *
 * Idempotent: a second call with the same inputs changes nothing and writes
 * nothing. Never throws; every failure is a returned `{ ok: false }`.
 *
 * @param {object} [params] - Inputs.
 * @param {string} [params.cwd] - Directory the session runs in (any depth inside the repo).
 * @param {NodeJS.ProcessEnv} [params.env] - Environment; defaults to `process.env`.
 * @param {ReadonlyArray<string>} [params.entries] - Patterns; defaults to {@link RUNTIME_EXCLUDE_ENTRIES}.
 * @param {(args: string[], options: object) => string} [params.execGit] - Git runner (test seam).
 * @returns {{ok: true, action: 'inserted'|'replaced'|'unchanged', file: string}
 *   | {ok: true, action: 'skipped', reason: 'not-a-repo'}
 *   | {ok: false, reason: 'malformed-block'|'symlinked-exclude'|'read-failed'|'write-failed', file: string, error?: string}}
 */
export function ensureRuntimeExclude({
  cwd, env = process.env, entries = RUNTIME_EXCLUDE_ENTRIES, execGit,
} = {}) {
  const commonDir = resolveCommonDir(cwd, { env, execGit });
  if (commonDir === null) return { ok: true, action: 'skipped', reason: 'not-a-repo' };

  const file = path.join(commonDir, 'info', 'exclude');
  if (isSymlink(file)) return { ok: false, reason: 'symlinked-exclude', file };

  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // A missing file (or a missing info/) is normal; anything else is not ours to overwrite.
    if (err?.code !== 'ENOENT') return { ok: false, reason: 'read-failed', file, error: err?.message };
  }

  const applied = applyManagedBlock(existing, entries);
  if (applied.action === 'malformed') return { ok: false, reason: 'malformed-block', file };
  if (applied.action === 'unchanged') return { ok: true, action: 'unchanged', file };

  try {
    atomicWriteTextSync(file, applied.text);
  } catch (err) {
    return { ok: false, reason: 'write-failed', file, error: err?.message };
  }
  return { ok: true, action: applied.action, file };
}
