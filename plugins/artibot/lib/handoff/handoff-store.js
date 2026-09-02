/**
 * Handoff Store — atomic write + rotation for `/save` markdown documents.
 *
 * Layout under {projectRoot}:
 *   .artibot/HANDOFF.md            — pointer to "latest", always overwritten
 *   .artibot/handoffs/<ts>.md      — archived snapshots, rotated by `keep`
 *
 * Public API:
 *   - writeHandoff(markdown, { projectRoot, keep, throttleMs, now, exec })
 *   - listHandoffs(projectRoot)
 *   - pruneHandoffs(projectRoot, { keep, exec })
 *   - readLatestHandoff(projectRoot)
 *   - checkHandoffTrackedIntegrity(projectRoot, { exec })
 *
 * Atomicity: every write goes through tmp-file + rename. Directory creation
 * is idempotent. The pointer file (`HANDOFF.md`) is never a rotation target.
 *
 * Git-tracked archive protection (fail-closed):
 *   Some projects commit `.artibot/handoffs/*.md`. In a fresh `git worktree`
 *   or right after `git merge`/`checkout`, every checked-out tracked file gets
 *   a brand-new mtime. The pre-fix store picked "newest archive" by mtime and
 *   (a) overwrote it in place under the 10-minute throttle, (b) unlinked
 *   tracked files past `keep`. Both showed up as ` M` / ` D` in `git status`.
 *   Now the store asks git which archives are tracked and never reuses or
 *   prunes those. If the project is a git work tree but the tracked set
 *   cannot be determined, the store refuses BOTH destructive actions
 *   (`pruneSkipped: 'git-unknown'`). Outside a git work tree the legacy
 *   behaviour is unchanged.
 *
 * @module lib/handoff/handoff-store
 */

import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';

const HANDOFF_FILE = 'HANDOFF.md';
const ARCHIVE_DIR = path.join('.artibot', 'handoffs');
// git pathspecs are always POSIX-style regardless of host platform.
const ARCHIVE_DIR_POSIX = '.artibot/handoffs';
const POINTER_REL = path.join('.artibot', HANDOFF_FILE);
const DEFAULT_KEEP = 30;
// Safety #4: rapid /save bursts (e.g. autopilot loops, user repeat-tapping the
// command) would otherwise spam the archive dir. When the latest archive is
// younger than this window, writeHandoff overwrites it in-place instead of
// creating a new file. The pointer (HANDOFF.md) is always refreshed.
const DEFAULT_THROTTLE_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 5000;
// `YYYY-MM-DD-HHMM.md` or `YYYY-MM-DD-HHMM-<n>.md` (n = collision sequence).
// The random-hex collision fallback (`-a1b2c3`) intentionally does NOT match:
// it is not orderable, so it falls back to mtime like any foreign filename.
const ARCHIVE_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-(\d+))?\.md$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve keep value from explicit option or `ARTIBOT_HANDOFF_KEEP` env.
 * @param {number|undefined} explicit
 * @returns {number}
 */
function resolveKeep(explicit) {
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const raw = process.env.ARTIBOT_HANDOFF_KEEP;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return DEFAULT_KEEP;
}

/**
 * Resolve throttle window from explicit option or `ARTIBOT_HANDOFF_THROTTLE_MS`
 * env. A value of 0 disables throttling. Negative / invalid input falls back
 * to the default. Mirrors `resolveKeep` semantics.
 * @param {number|undefined} explicit
 * @returns {number}
 */
function resolveThrottleMs(explicit) {
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const raw = process.env.ARTIBOT_HANDOFF_THROTTLE_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return DEFAULT_THROTTLE_MS;
}

/**
 * Build a base filename in the form YYYY-MM-DD-HHMM (local time).
 * @param {Date} d
 * @returns {string}
 */
function baseStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Parse an archive filename produced by `baseStamp` + `pickArchiveName` back
 * into an epoch-ms stamp (local time, the same clock `baseStamp` used) and a
 * collision sequence (`1` for `<stamp>.md`, `n` for `<stamp>-n.md`).
 *
 * Why the filename and not mtime: the stamp is written once, by this store,
 * from the caller's clock, and nothing git does (checkout, merge, worktree
 * add) can refresh it. mtime is rewritten by every checkout, so on a fresh
 * worktree a months-old committed archive looks "younger" than a file this
 * session wrote a minute ago. Filename stamps are therefore the primary
 * ordering key and mtime is only a fallback for non-conforming names.
 *
 * Resolution is one minute. During a DST fall-back hour the parse is
 * ambiguous by up to 1h; that only shifts the throttle decision, never
 * the ordering between files written minutes apart.
 *
 * @param {string} filename
 * @returns {{ stampMs: number, seq: number } | null}
 */
function parseArchiveStamp(filename) {
  const m = ARCHIVE_STAMP_RE.exec(filename);
  if (!m) return null;
  const [, y, mo, d, h, mi, seq] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  const stampMs = date.getTime();
  if (!Number.isFinite(stampMs)) return null;
  return { stampMs, seq: seq ? Number(seq) : 1 };
}

/**
 * Choose the next non-colliding filename in `archiveDir`. Uses `<base>.md`
 * first; on collision, appends `-2`, `-3`, ...
 * @param {string} archiveDir
 * @param {string} base
 * @returns {Promise<string>} The chosen filename (basename only)
 */
async function pickArchiveName(archiveDir, base) {
  const first = `${base}.md`;
  if (!existsSync(path.join(archiveDir, first))) return first;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}.md`;
    if (!existsSync(path.join(archiveDir, candidate))) return candidate;
  }
  // Fallback — random suffix to guarantee progress.
  return `${base}-${crypto.randomBytes(3).toString('hex')}.md`;
}

/**
 * Atomic write: tmp file in the same directory, then rename. Guarantees
 * no partial reader observes a half-written file.
 *
 * @param {string} targetPath
 * @param {string} content
 * @returns {Promise<void>}
 */
async function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, targetPath);
  } catch (err) {
    // Best-effort: clean stray tmp on rename failure (e.g. Windows EPERM)
    try { await rm(tmp, { force: true }); } catch { /* noop */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Git probes (shell-free, injectable)
// ---------------------------------------------------------------------------

/**
 * @typedef {(file: string, args: string[], opts: { cwd: string }) => string} ExecFn
 *   Synchronous runner returning stdout as a UTF-8 string and throwing on
 *   non-zero exit / spawn failure. Tests inject a fake; production uses
 *   `defaultExec`.
 */

/**
 * Default runner: `execFileSync` with no shell, hidden window, 5s timeout.
 * `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` are stripped so a probe
 * launched from inside a git hook still answers for `cwd`, not for the hook's
 * repository.
 * @type {ExecFn}
 */
function defaultExec(file, args, opts) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync(file, args, {
    cwd: opts.cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Normalise a path for tracked-set membership. Both sides of the comparison
 * are derived from `projectRoot`, so `path.resolve` alone lines them up;
 * lower-casing on win32 covers git reporting index-case while the directory
 * listing reports on-disk case.
 * @param {string} p
 * @returns {string}
 */
function pathKey(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Is `projectRoot` inside a git work tree?
 *
 * Three-way answer so callers can fail closed:
 *   - `true`   — git says we are inside a work tree
 *   - `false`  — git says no, or git is unavailable AND no `.git` entry exists
 *                in `projectRoot` or ANY of its ancestors
 *   - `null`   — git is unavailable but a `.git` file/dir exists somewhere up
 *                the tree (worktrees use a `.git` *file*), so we are probably
 *                in a repo and cannot prove otherwise
 *
 * The ancestor walk matters (review finding 2026-09-02): a `projectRoot` one
 * level below the repo root has no `.git` of its own, so a sibling-only check
 * turned "git binary missing / spawn failed / safe.directory refusal" into
 * "not a repo" and the legacy prune deleted tracked archives. Absence of
 * evidence is not evidence of absence — only a full walk to the filesystem
 * root with zero `.git` entries may unlock the legacy path.
 *
 * @param {string} projectRoot
 * @param {ExecFn} exec
 * @returns {boolean|null}
 */
function probeInsideWorkTree(projectRoot, exec) {
  try {
    return exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot }).trim() === 'true';
  } catch {
    return hasGitAncestor(projectRoot) ? null : false;
  }
}

/**
 * Does `dir` or any ancestor contain a `.git` entry (dir or file)?
 * Pure filesystem lookup, bounded by the filesystem root.
 * @param {string} dir
 * @returns {boolean}
 */
function hasGitAncestor(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(cur, '.git'))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * @typedef {{ inRepo: boolean, tracked: Set<string> | null }} TrackingInfo
 *   `inRepo=false` → legacy behaviour, no constraints.
 *   `inRepo=true, tracked=Set` → members (via `pathKey`) are protected.
 *   `inRepo=true, tracked=null` → fail-closed: git could not answer.
 */

/**
 * Resolve which files under `.artibot/handoffs` git tracks.
 * Never throws; every failure collapses into one of the three
 * `TrackingInfo` states.
 *
 * @param {string} projectRoot
 * @param {ExecFn} exec
 * @returns {TrackingInfo}
 */
function probeTrackedArchives(projectRoot, exec) {
  const inside = probeInsideWorkTree(projectRoot, exec);
  if (inside === false) return { inRepo: false, tracked: null };
  if (inside === null) return { inRepo: true, tracked: null };
  try {
    const out = exec('git', ['ls-files', '-z', '--', ARCHIVE_DIR_POSIX], { cwd: projectRoot });
    const tracked = new Set(
      out.split('\0').filter(Boolean).map((rel) => pathKey(path.resolve(projectRoot, rel))),
    );
    return { inRepo: true, tracked };
  } catch {
    return { inRepo: true, tracked: null };
  }
}

/**
 * @param {TrackingInfo} tracking
 * @param {string} filePath
 * @returns {boolean}
 */
function isTracked(tracking, filePath) {
  return Boolean(tracking.tracked && tracking.tracked.has(pathKey(filePath)));
}

// ---------------------------------------------------------------------------
// Public: writeHandoff
// ---------------------------------------------------------------------------

/**
 * Choose an archive target for this write.
 *
 * Reuse (in-place overwrite) happens only when ALL of the following hold:
 *   1. throttling is on (`throttleMs > 0`);
 *   2. the tracked set is known, or we are outside a git work tree
 *      (`tracked === null` inside a repo → never reuse: fail-closed);
 *   3. the newest archive (stamp-aware order, see `listHandoffs`) is NOT
 *      git-tracked;
 *   4. its filename carries a parseable stamp — i.e. this store created it.
 *      A foreign filename has unknown provenance, so overwriting it is never
 *      allowed even though it may participate in listing/pruning by mtime;
 *   5. the stamp is younger than `throttleMs` measured against `now`.
 *      Age comes from the stamp, not mtime, so a checkout/copy/sync that
 *      refreshes mtimes cannot make an old archive look "young". Side effect:
 *      the throttle window is anchored to the archive's creation minute, so a
 *      burst longer than `throttleMs` rolls into a new file instead of folding
 *      forever into one (bounded folding).
 *
 * Only the newest archive is ever a candidate. Reusing an older untracked
 * file behind a newer tracked one would put the newest content under an
 * older stamp and break "newest by name == newest by content".
 *
 * @param {string} projectRoot
 * @param {string} archiveDir
 * @param {Date} now
 * @param {number} throttleMs
 * @param {TrackingInfo} tracking
 * @returns {Promise<{ archivePath: string, throttled: boolean }>}
 */
async function resolveArchiveTarget(projectRoot, archiveDir, now, throttleMs, tracking) {
  const reuseAllowed = throttleMs > 0 && !(tracking.inRepo && tracking.tracked === null);
  if (reuseAllowed) {
    const nowMs = now.getTime();
    const newest = (await listHandoffs(projectRoot))[0];
    if (
      newest
      && !isTracked(tracking, newest.path)
      && Number.isFinite(newest.stampMs)
      && (nowMs - newest.stampMs) < throttleMs
    ) {
      return { archivePath: newest.path, throttled: true };
    }
  }
  const base = baseStamp(now);
  const archiveName = await pickArchiveName(archiveDir, base);
  return { archivePath: path.join(archiveDir, archiveName), throttled: false };
}

/**
 * Write `markdown` as the new latest handoff AND archive a timestamped copy.
 * Prunes older archives down to `keep`.
 *
 * Safety #4 — throttle: when the newest existing archive was created within
 * `throttleMs` of `now`, the archive is overwritten in place instead of
 * creating a fresh file. The pointer (HANDOFF.md) is ALWAYS refreshed so
 * /resume sees the latest content. `throttled: true` is surfaced in the
 * return shape so callers can render a friendlier UX line.
 *
 * Git-tracked protection: see the module header and `resolveArchiveTarget`.
 * `protectedTracked` is the number of git-tracked archive files found under
 * `.artibot/handoffs`; all of them are exempt from reuse and prune.
 * `pruneSkipped` is `'git-unknown'` when the project is a git work tree but
 * the tracked set could not be determined — then nothing was reused and
 * nothing was pruned, and the caller should say so.
 *
 * @param {string} markdown
 * @param {{
 *   projectRoot: string,
 *   keep?: number,
 *   throttleMs?: number,
 *   now?: () => Date,
 *   exec?: ExecFn,
 * }} options
 * @returns {Promise<{
 *   latestPath: string,
 *   archivePath: string,
 *   pruned: number,
 *   throttled: boolean,
 *   protectedTracked: number,
 *   pruneSkipped: null | 'git-unknown',
 * }>}
 */
export async function writeHandoff(markdown, options) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be string');
  const { projectRoot } = options ?? {};
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const now = options.now ?? (() => new Date());
  const exec = options.exec ?? defaultExec;
  const keep = resolveKeep(options.keep);
  const throttleMs = resolveThrottleMs(options.throttleMs);

  const archiveDir = path.join(projectRoot, ARCHIVE_DIR);
  const pointerPath = path.join(projectRoot, POINTER_REL);
  await mkdir(archiveDir, { recursive: true });

  const tracking = probeTrackedArchives(projectRoot, exec);
  const { archivePath, throttled } = await resolveArchiveTarget(
    projectRoot, archiveDir, now(), throttleMs, tracking,
  );

  // Write archive first, then pointer. atomicWrite uses rename so even an
  // in-place overwrite is crash-safe.
  await atomicWrite(archivePath, markdown);
  await atomicWrite(pointerPath, markdown);

  // Force archive mtime to match `now()` so the mtime fallback (non-stamped
  // names) and any mtime-sorting consumer follow the caller's clock rather
  // than filesystem-recorded write time. Deterministic across timezones (CI
  // runs UTC, local dev runs KST) and immune to clock skew between Date.now()
  // and fs mtime. Best-effort: swallow utimes failures (e.g. read-only
  // filesystem).
  try {
    const ts = now();
    await utimes(archivePath, ts, ts);
  } catch { /* noop */ }

  // Throttled writes never increase archive cardinality, so skip the prune.
  const prune = throttled
    ? { removed: 0, protectedTracked: countTracked(await listHandoffs(projectRoot), tracking), skipped: null }
    : await pruneWithTracking(projectRoot, keep, tracking);
  return {
    latestPath: pointerPath,
    archivePath,
    pruned: prune.removed,
    throttled,
    protectedTracked: prune.protectedTracked,
    pruneSkipped: prune.skipped,
  };
}

// ---------------------------------------------------------------------------
// Public: listHandoffs
// ---------------------------------------------------------------------------

/**
 * Sort key: filename stamp when the name conforms, otherwise mtime. Both are
 * epoch-ms on the same (local) clock, so mixing them is coherent.
 * @param {{ stampMs: number|null, mtime: number }} r
 * @returns {number}
 */
function sortKey(r) {
  return Number.isFinite(r.stampMs) ? r.stampMs : r.mtime;
}

/**
 * List archived handoff files, newest first.
 *
 * Ordering: filename stamp (`YYYY-MM-DD-HHMM[-n].md`) desc, then collision
 * sequence desc, then mtime desc. Files whose names do not conform sort by
 * mtime in the same stream. See `parseArchiveStamp` for why the stamp beats
 * mtime.
 *
 * @param {string} projectRoot
 * @returns {Promise<Array<{
 *   filename: string,
 *   mtime: number,
 *   sizeBytes: number,
 *   path: string,
 *   stampMs: number | null,
 *   seq: number | null,
 * }>>}
 */
export async function listHandoffs(projectRoot) {
  if (!projectRoot) return [];
  const archiveDir = path.join(projectRoot, ARCHIVE_DIR);
  let entries;
  try {
    entries = await readdir(archiveDir);
  } catch {
    return [];
  }

  const records = [];
  for (const filename of entries) {
    if (!filename.endsWith('.md')) continue;
    if (filename.startsWith('.')) continue;
    const fullPath = path.join(archiveDir, filename);
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) continue;
      const parsed = parseArchiveStamp(filename);
      records.push({
        filename,
        path: fullPath,
        mtime: st.mtimeMs,
        sizeBytes: st.size,
        stampMs: parsed ? parsed.stampMs : null,
        seq: parsed ? parsed.seq : null,
      });
    } catch {
      // Skip entries that race-disappear between readdir and stat.
    }
  }
  records.sort((a, b) => (sortKey(b) - sortKey(a))
    || ((b.seq ?? 0) - (a.seq ?? 0))
    || (b.mtime - a.mtime));
  return records;
}

// ---------------------------------------------------------------------------
// Public: pruneHandoffs
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ path: string }>} records
 * @param {TrackingInfo} tracking
 * @returns {number}
 */
function countTracked(records, tracking) {
  return records.reduce((n, r) => n + (isTracked(tracking, r.path) ? 1 : 0), 0);
}

/**
 * Prune with a pre-resolved tracking probe (shared by writeHandoff so git is
 * spawned once per save).
 *
 * `keep` counts positions in the newest-first order regardless of tracking:
 * tracked files inside the window occupy slots, tracked files beyond it are
 * skipped, untracked files beyond it are unlinked. Consequence: in a project
 * that commits its archives the directory may legitimately hold more than
 * `keep` files — git-tracked is the user's explicit "keep this", and the
 * store only rotates what it owns.
 *
 * @param {string} projectRoot
 * @param {number} keep
 * @param {TrackingInfo} tracking
 * @returns {Promise<{ removed: number, protectedTracked: number, skipped: null | 'git-unknown' }>}
 */
async function pruneWithTracking(projectRoot, keep, tracking) {
  if (tracking.inRepo && tracking.tracked === null) {
    return { removed: 0, protectedTracked: 0, skipped: 'git-unknown' };
  }
  const all = await listHandoffs(projectRoot);
  const protectedTracked = countTracked(all, tracking);
  if (all.length <= keep) return { removed: 0, protectedTracked, skipped: null };

  let removed = 0;
  for (const v of all.slice(keep)) {
    if (isTracked(tracking, v.path)) continue;
    try {
      await unlink(v.path);
      removed += 1;
    } catch {
      // Best-effort: a missing or locked file should not fail the whole prune.
    }
  }
  return { removed, protectedTracked, skipped: null };
}

/**
 * Remove archive files beyond `keep`. Pointer file is never removed.
 * Git-tracked archives are never removed; inside a git work tree whose
 * tracked set cannot be read, nothing is removed (`skipped: 'git-unknown'`).
 *
 * @param {string} projectRoot
 * @param {{ keep?: number, exec?: ExecFn }} options
 * @returns {Promise<{ removed: number, protectedTracked: number, skipped: null | 'git-unknown' }>}
 */
export async function pruneHandoffs(projectRoot, options = {}) {
  if (!projectRoot) return { removed: 0, protectedTracked: 0, skipped: null };
  const keep = resolveKeep(options.keep);
  const tracking = probeTrackedArchives(projectRoot, options.exec ?? defaultExec);
  return pruneWithTracking(projectRoot, keep, tracking);
}

// ---------------------------------------------------------------------------
// Public: readLatestHandoff
// ---------------------------------------------------------------------------

/**
 * Read the pointer file. Returns `null` when missing or unreadable.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ path: string, content: string, mtime: number } | null>}
 */
export async function readLatestHandoff(projectRoot) {
  if (!projectRoot) return null;
  const pointerPath = path.join(projectRoot, POINTER_REL);
  if (!existsSync(pointerPath)) return null;
  try {
    const content = await readFile(pointerPath, 'utf8');
    const st = statSync(pointerPath);
    return { path: pointerPath, content, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: checkHandoffTrackedIntegrity
// ---------------------------------------------------------------------------

/**
 * Parse `git status --porcelain -z` output into modified / deleted path
 * lists. Rename and copy entries carry a second NUL-terminated field (the
 * original path); a rename of a tracked handoff is reported under `modified`
 * as `<new> (renamed from <orig>)` so it cannot slip past the post-save probe
 * (review finding 2026-09-02). Untracked (`??`) and added (`A`) entries are
 * neither modified nor deleted.
 *
 * @param {string} out
 * @returns {{ modified: string[], deleted: string[] }}
 */
function parsePorcelainZ(out) {
  const fields = out.split('\0');
  const modified = [];
  const deleted = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (xy.includes('R') || xy.includes('C')) {
      i += 1;
      const orig = fields[i] ?? '';
      modified.push(orig ? `${rel} (renamed from ${orig})` : rel);
      continue;
    }
    if (xy.includes('D')) deleted.push(rel);
    else if (xy.includes('M')) modified.push(rel);
  }
  return { modified, deleted };
}

/**
 * Post-save integrity probe for `/save`: did anything under
 * `.artibot/handoffs` end up modified or deleted relative to the index?
 * Both lists must be empty after a correct save. Never throws.
 *
 * @param {string} projectRoot
 * @param {{ exec?: ExecFn }} [options]
 * @returns {{
 *   inRepo: boolean,
 *   modified: string[],
 *   deleted: string[],
 *   error: null | string,
 * }} `error` is set (and lists are empty) when git could not answer — the
 *   caller must report "미확인", not "0/0".
 */
export function checkHandoffTrackedIntegrity(projectRoot, options = {}) {
  const empty = { inRepo: false, modified: [], deleted: [], error: null };
  if (!projectRoot) return empty;
  const exec = options.exec ?? defaultExec;
  const inside = probeInsideWorkTree(projectRoot, exec);
  if (inside === false) return empty;
  if (inside === null) return { ...empty, inRepo: true, error: 'git unavailable' };
  try {
    const out = exec('git', ['status', '--porcelain', '-z', '--', ARCHIVE_DIR_POSIX], { cwd: projectRoot });
    return { inRepo: true, ...parsePorcelainZ(out), error: null };
  } catch (err) {
    return { ...empty, inRepo: true, error: err?.message ?? String(err) };
  }
}

// Internal constants for tests / callers.
export const _internals = Object.freeze({
  HANDOFF_FILE,
  ARCHIVE_DIR,
  POINTER_REL,
  DEFAULT_KEEP,
  DEFAULT_THROTTLE_MS,
  parseArchiveStamp,
  parsePorcelainZ,
});
