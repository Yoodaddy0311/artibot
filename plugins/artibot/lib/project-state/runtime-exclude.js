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
 * away: a walk up to the work tree that mirrors git's own discovery (below), then
 * `./git-common-dir.js#resolveGitCommonDir` — the SAME resolution the state
 * store and the ledger bind to, so the exclude lands in the repository they
 * write for. Git stays the authority where a marker cannot see: when `GIT_DIR`,
 * `GIT_COMMON_DIR` or `GIT_WORK_TREE` redirect discovery, `rev-parse` decides
 * (the same tiering `resolveProjectRoot` uses). A directory with no repository
 * above it spawns nothing and is a no-op.
 *
 * ── The walk mirrors git, not just `.git` ─────────────────────────────────
 * At each level git tests `<dir>/.git` first and then `<dir>` itself as a bare
 * repository (a `HEAD` file plus `objects/` and `refs/`), and it does not climb
 * into a directory named by `GIT_CEILING_DIRECTORIES`. So does this walk: a cwd
 * inside a bare repository — or inside a `.git` directory — is a no-op instead of
 * reaching past it to whatever repository happens to enclose it, and a ceiling
 * directory stops the climb (the start directory is never excluded, as in git;
 * a ceiling matches through symlinks, junctions and 8.3 names, as in git).
 *
 * ── What the block is ─────────────────────────────────────────────────────
 * `# >>> artibot runtime >>>` … `# <<< artibot runtime <<<`. Everything inside
 * is ours and is REPLACED when it differs; every byte outside is preserved
 * exactly. "Exactly" is literal: the file is read and written as RAW BYTES and
 * decoded 1:1 as latin1 (the markers and entries are ASCII), never as UTF-8, so a
 * cp949 or latin-1 line, a UTF-8 BOM or CRLF outside the block comes back
 * unchanged. Reading it as UTF-8 replaced every invalid byte with U+FFFD on the
 * way out (measured: `caf` + 0xE9 came back as 63 61 66 ef bf bd), silently
 * breaking the user's own patterns. Every pattern starts with the any-depth
 * prefix (double star, then slash) because the hooks' project root is not always
 * the repository root — a nested cwd is a measured case, see the `.gitignore`
 * note on `.artibot/ledger/` — and that prefix also matches the top level.
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
 *   - It never touches a UTF-16 file (a BOM of FF FE or FE FF, or any NUL byte),
 *     and says so (`utf16-exclude`). Git does not read UTF-16 ignore files, so
 *     that file is already inert to git. A UTF-16 block would be exactly as
 *     unreadable to git while reporting success; an ASCII block appended would
 *     leave a mixed-encoding file that editors show as mojibake; converting the
 *     user's file would change bytes outside the block. Skipping, with the remedy
 *     in the report, is the only outcome that breaks nothing.
 *   - It never writes a file nobody may write (no write bit, or the OS refuses
 *     us). A read-only `info/exclude` is a deliberate lock: it is skipped
 *     (`read-only`) and stays QUIET, since a note on every session start would
 *     only nag about a choice the user made. Without this check a POSIX rename
 *     would replace the locked file and lose its mode.
 *   - It does not close a race with another writer of the same file — the host
 *     keeps its own `# claude-code-runtime` section there. It narrows it: the
 *     file is re-read just before the rename and, if the bytes differ from what
 *     was read at the start, nothing is written (`changed-during-write`; the next
 *     session start retries). A write landing between that re-read and the rename
 *     is still lost — microseconds, not eliminated.
 *
 * Layer: L2. Imports `lib/core` and a sibling only.
 *
 * @module lib/project-state/runtime-exclude
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureDirSync, renameWithRetry } from '../core/file.js';
import { normalizeDirPath, sameDirPath } from '../core/platform.js';
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

/** The remedy named in the `utf16-exclude` report. */
const UTF16_HINT = 'info/exclude is UTF-16 or holds NUL bytes, which git cannot read; left as it is - re-save it as UTF-8';

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
 * `text` without trailing spaces and tabs — ASCII only, and a plain loop.
 *
 * Not `trimEnd()`: on a latin1-decoded file that also strips U+00A0, i.e. a
 * 0xA0 byte, which is a legitimate trail byte of a multibyte character. And not a
 * `/[ \t]+$/` regex, which backtracks quadratically on a long run of spaces.
 *
 * @param {string} text - One line, without its terminator.
 * @returns {string} The line without trailing ASCII blanks.
 */
function trimAsciiEnd(text) {
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0x09)) end -= 1;
  return end === text.length ? text : text.slice(0, end);
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
    const marker = trimAsciiEnd(lines[i].content);
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
 * CONTRACT FOR THE CALLER: `text` is a byte-preserving decode of the file —
 * latin1, where each byte is exactly one char — and the result is encoded back
 * the same way. The markers and the entries are ASCII, so nothing else about the
 * decoding matters here; a UTF-8 decode would not round-trip (see the module
 * header).
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

/** True when `dir` is a bare repository: a `HEAD` file plus `objects/` and `refs/` directories. */
function isBareRepoDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'HEAD')).isFile()
      && fs.statSync(path.join(dir, 'objects')).isDirectory()
      && fs.statSync(path.join(dir, 'refs')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `GIT_CEILING_DIRECTORIES` as normalised absolute paths. Empty entries (git's
 * "do not resolve symlinks from here on" marker) and relative entries (git
 * ignores them) are dropped; an MSYS `/c/x` spelling becomes `C:\x` on Windows.
 *
 * @param {unknown} value - The raw variable.
 * @returns {string[]} Zero or more absolute directories.
 */
function parseCeilings(value) {
  if (typeof value !== 'string' || value === '') return [];
  return value.split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && path.isAbsolute(entry))
    .map((entry) => normalizeDirPath(entry))
    .filter((entry) => entry !== null);
}

/**
 * True when `a` and `b` name the same directory: the same normalised path, or —
 * as git compares a ceiling with the current directory — the same directory once
 * symlinks, junctions and 8.3 short names are resolved. Measured 2026-09-30 (git
 * 2.54.0.windows.1): the ceiling was honoured in all six spelling combinations
 * tried (cwd or ceiling through a junction, short against long name), so a
 * textual comparison alone would climb past a ceiling git respects. A path that
 * cannot be resolved does not match.
 *
 * @param {string} a - A directory path.
 * @param {string} b - Another directory path.
 * @returns {boolean} Whether they are one directory.
 */
function sameDirResolved(a, b) {
  if (sameDirPath(a, b)) return true;
  try {
    return sameDirPath(fs.realpathSync.native(a), fs.realpathSync.native(b));
  } catch {
    return false;
  }
}

/**
 * The work-tree root that contains `start`, found the way git finds it.
 *
 * Per level: `<dir>/.git` first (work tree), then `<dir>` as a bare repository
 * (no work tree: stop, `null`). The climb never enters a `GIT_CEILING_DIRECTORIES`
 * directory, and the start directory is always examined.
 *
 * @param {string} start - Directory to start from.
 * @param {NodeJS.ProcessEnv} env - Environment holding an optional ceiling list.
 * @returns {string|null} The work-tree root, or `null` (none, bare, or past a ceiling).
 */
function findWorkTreeRoot(start, env) {
  const ceilings = parseCeilings(env?.GIT_CEILING_DIRECTORIES);
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (isBareRepoDir(dir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir || ceilings.some((ceiling) => sameDirResolved(ceiling, parent))) return null;
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

/** The common dir from file reads: the work tree git would find, then its pointer. */
function commonDirViaMarker(cwd, env) {
  const root = findWorkTreeRoot(cwd, env);
  return root === null ? null : resolveGitCommonDir(root);
}

/**
 * Resolve the git common directory for `cwd`, or `null` when there is none.
 *
 * Normal path: file reads, no process. When `GIT_DIR`, `GIT_COMMON_DIR` or
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
  const common = redirected ? commonDirViaGit(cwd, env, execGit) : commonDirViaMarker(cwd, env);
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

/** The file's raw bytes, or `null` when it does not exist. Throws on any other failure. */
function readRaw(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** True when the OS lets this process write `file`. */
function canWrite(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the bytes cannot be an ASCII-compatible exclude file: a UTF-16 or
 * UTF-32 byte-order mark (FF FE / FE FF), or any NUL byte — UTF-16 without a BOM
 * and a mixed-encoding file both carry NULs, and a cp949, latin-1 or UTF-8 file
 * never does.
 *
 * @param {Buffer} bytes - The file as read.
 * @returns {boolean} Whether it must be left alone.
 */
function looksUtf16(bytes) {
  const [first, second] = bytes;
  const bom = (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff);
  return bom || bytes.includes(0);
}

/**
 * Read the exclude file as raw bytes together with what decides whether it may
 * be rewritten. Never throws.
 *
 * `writable` is false for a file with no write bit at all (a deliberate lock,
 * and the check that also holds for root, which `access` does not) or one the OS
 * refuses this process.
 *
 * @param {string} file - `<common dir>/info/exclude`.
 * @returns {{error: Error}|{exists: false}|{exists: true, raw: Buffer, mode: number, writable: boolean}}
 *   The outcome.
 */
function inspectExclude(file) {
  let raw;
  let mode;
  try {
    raw = readRaw(file);
    if (raw === null) return { exists: false };
    ({ mode } = fs.statSync(file));
  } catch (error) {
    return { error };
  }
  return { exists: true, raw, mode: mode & 0o7777, writable: (mode & 0o222) !== 0 && canWrite(file) };
}

/** True when two reads agree: same bytes, or both absent. `undefined` (unreadable) never agrees. */
function sameBytes(now, before) {
  if (now === undefined) return false;
  if (now === null || before === null) return now === before;
  return now.equals(before);
}

/** The file's bytes now: `null` if absent, `undefined` if it cannot be read (counts as changed). */
function rereadRaw(file) {
  try {
    return readRaw(file);
  } catch {
    return undefined;
  }
}

/**
 * Replace `file` with `bytes` through a temp sibling and a rename, so a crash
 * never leaves a torn file. Raw bytes in, raw bytes out: no text encoding is
 * applied anywhere.
 *
 * Just before the rename the file is read again; if it no longer matches
 * `before` (another writer got there first) nothing is written and the temp file
 * is removed. The original `mode` is put back on the temp file so the rename does
 * not change it.
 *
 * @param {string} file - Destination.
 * @param {Buffer} bytes - Exact new content.
 * @param {{before: Buffer|null, mode?: number}} guard - The bytes read at the start
 *   (`null` when the file was absent) and the mode to preserve.
 * @returns {'written'|'changed'} Whether the rename happened.
 */
function writeRawAtomic(file, bytes, { before, mode }) {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  let committed = false;
  try {
    fs.writeFileSync(tmp, bytes);
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    if (!sameBytes(rereadRaw(file), before)) return 'changed';
    renameWithRetry(tmp, file);
    committed = true;
    return 'written';
  } finally {
    if (!committed) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
}

/**
 * Make sure `<git common dir>/info/exclude` carries the managed runtime block.
 *
 * Idempotent: a second call with the same inputs changes nothing and writes
 * nothing. Never throws; every failure is a returned `{ ok: false }`. A file the
 * user locked (read-only) is not a failure: it is skipped quietly.
 *
 * @param {object} [params] - Inputs.
 * @param {string} [params.cwd] - Directory the session runs in (any depth inside the repo).
 * @param {NodeJS.ProcessEnv} [params.env] - Environment; defaults to `process.env`.
 * @param {ReadonlyArray<string>} [params.entries] - Patterns; defaults to {@link RUNTIME_EXCLUDE_ENTRIES}.
 * @param {(args: string[], options: object) => string} [params.execGit] - Git runner (test seam).
 * @returns {{ok: true, action: 'inserted'|'replaced'|'unchanged', file: string}
 *   | {ok: true, action: 'skipped', reason: 'not-a-repo'}
 *   | {ok: true, action: 'skipped', reason: 'read-only', file: string}
 *   | {ok: false, reason: 'malformed-block'|'symlinked-exclude'|'utf16-exclude'|'changed-during-write'|'read-failed'|'write-failed', file: string, error?: string}}
 */
export function ensureRuntimeExclude({
  cwd, env = process.env, entries = RUNTIME_EXCLUDE_ENTRIES, execGit,
} = {}) {
  const commonDir = resolveCommonDir(cwd, { env, execGit });
  if (commonDir === null) return { ok: true, action: 'skipped', reason: 'not-a-repo' };

  const file = path.join(commonDir, 'info', 'exclude');
  if (isSymlink(file)) return { ok: false, reason: 'symlinked-exclude', file };

  const seen = inspectExclude(file);
  if ('error' in seen) return { ok: false, reason: 'read-failed', file, error: seen.error?.message };
  if (seen.exists && !seen.writable) return { ok: true, action: 'skipped', reason: 'read-only', file };
  if (seen.exists && looksUtf16(seen.raw)) return { ok: false, reason: 'utf16-exclude', file, error: UTF16_HINT };

  const before = seen.exists ? seen.raw : null;
  const applied = applyManagedBlock(before === null ? '' : before.toString('latin1'), entries);
  if (applied.action === 'malformed') return { ok: false, reason: 'malformed-block', file };
  if (applied.action === 'unchanged') return { ok: true, action: 'unchanged', file };

  try {
    const outcome = writeRawAtomic(file, Buffer.from(applied.text, 'latin1'), {
      before, mode: seen.exists ? seen.mode : undefined,
    });
    if (outcome === 'changed') return { ok: false, reason: 'changed-during-write', file };
  } catch (err) {
    return { ok: false, reason: 'write-failed', file, error: err?.message };
  }
  return { ok: true, action: applied.action, file };
}
