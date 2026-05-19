/**
 * Handoff Store — atomic write + rotation for `/save` markdown documents.
 *
 * Layout under {projectRoot}:
 *   .artibot/HANDOFF.md            — pointer to "latest", always overwritten
 *   .artibot/handoffs/<ts>.md      — archived snapshots, rotated by `keep`
 *
 * Public API:
 *   - writeHandoff(markdown, { projectRoot, keep, now })
 *   - listHandoffs(projectRoot)
 *   - pruneHandoffs(projectRoot, { keep })
 *   - readLatestHandoff(projectRoot)
 *
 * Atomicity: every write goes through tmp-file + rename. Directory creation
 * is idempotent. The pointer file (`HANDOFF.md`) is never a rotation target.
 *
 * @module lib/handoff/handoff-store
 */

import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const HANDOFF_FILE = 'HANDOFF.md';
const ARCHIVE_DIR = path.join('.artibot', 'handoffs');
const POINTER_REL = path.join('.artibot', HANDOFF_FILE);
const DEFAULT_KEEP = 30;
// Safety #4: rapid /save bursts (e.g. autopilot loops, user repeat-tapping the
// command) would otherwise spam the archive dir. When the latest archive is
// younger than this window, writeHandoff overwrites it in-place instead of
// creating a new file. The pointer (HANDOFF.md) is always refreshed.
const DEFAULT_THROTTLE_MS = 10 * 60 * 1000;

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
 * Build a base filename in the form YYYY-MM-DD-HHMM.
 * @param {Date} d
 * @returns {string}
 */
function baseStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}`;
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
// Public: writeHandoff
// ---------------------------------------------------------------------------

/**
 * Write `markdown` as the new latest handoff AND archive a timestamped copy.
 * Prunes older archives down to `keep`.
 *
 * Safety #4 — throttle: when the newest existing archive was written within
 * `throttleMs` of `now`, the archive is overwritten in place instead of
 * creating a fresh file. The pointer (HANDOFF.md) is ALWAYS refreshed so
 * /resume sees the latest content. `throttled: true` is surfaced in the
 * return shape so callers can render a friendlier UX line.
 *
 * @param {string} markdown
 * @param {{
 *   projectRoot: string,
 *   keep?: number,
 *   throttleMs?: number,
 *   now?: () => Date,
 * }} options
 * @returns {Promise<{
 *   latestPath: string,
 *   archivePath: string,
 *   pruned: number,
 *   throttled: boolean,
 * }>}
 */
/**
 * Choose an archive target for this write. If throttling is active AND the
 * newest existing archive is within `throttleMs` of `nowMs`, return that file
 * for in-place overwrite. Otherwise, allocate a fresh `<baseStamp>.md` name.
 *
 * @param {string} projectRoot
 * @param {string} archiveDir
 * @param {Date} now
 * @param {number} throttleMs
 * @returns {Promise<{ archivePath: string, throttled: boolean }>}
 */
async function resolveArchiveTarget(projectRoot, archiveDir, now, throttleMs) {
  const nowMs = now.getTime();
  const existing = throttleMs > 0 ? await listHandoffs(projectRoot) : [];
  const newest = existing[0];
  if (newest && Number.isFinite(newest.mtime) && (nowMs - newest.mtime) < throttleMs) {
    return { archivePath: newest.path, throttled: true };
  }
  const base = baseStamp(now);
  const archiveName = await pickArchiveName(archiveDir, base);
  return { archivePath: path.join(archiveDir, archiveName), throttled: false };
}

export async function writeHandoff(markdown, options) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be string');
  const { projectRoot } = options ?? {};
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const now = options.now ?? (() => new Date());
  const keep = resolveKeep(options.keep);
  const throttleMs = resolveThrottleMs(options.throttleMs);

  const archiveDir = path.join(projectRoot, ARCHIVE_DIR);
  const pointerPath = path.join(projectRoot, POINTER_REL);
  await mkdir(archiveDir, { recursive: true });

  const { archivePath, throttled } = await resolveArchiveTarget(
    projectRoot, archiveDir, now(), throttleMs,
  );

  // Write archive first, then pointer. atomicWrite uses rename so even an
  // in-place overwrite is crash-safe.
  await atomicWrite(archivePath, markdown);
  await atomicWrite(pointerPath, markdown);

  // Force archive mtime to match `now()` so the throttle decision is driven
  // by the caller's clock rather than filesystem-recorded write time. This
  // makes the behavior deterministic across timezones (CI runs UTC, local
  // dev runs KST) and immune to clock skew between Date.now() and fs mtime.
  // Best-effort: swallow utimes failures (e.g. read-only filesystem) — the
  // mtime mismatch only hurts the next call's throttle decision.
  try {
    const ts = now();
    await utimes(archivePath, ts, ts);
  } catch { /* noop */ }

  // Throttled writes never increase archive cardinality, so skip the prune.
  const pruned = throttled ? 0 : (await pruneHandoffs(projectRoot, { keep })).removed;
  return { latestPath: pointerPath, archivePath, pruned, throttled };
}

// ---------------------------------------------------------------------------
// Public: listHandoffs
// ---------------------------------------------------------------------------

/**
 * List archived handoff files sorted by mtime desc.
 *
 * @param {string} projectRoot
 * @returns {Promise<Array<{ filename: string, mtime: number, sizeBytes: number, path: string }>>}
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
      records.push({
        filename,
        path: fullPath,
        mtime: st.mtimeMs,
        sizeBytes: st.size,
      });
    } catch {
      // Skip entries that race-disappear between readdir and stat.
    }
  }
  records.sort((a, b) => b.mtime - a.mtime);
  return records;
}

// ---------------------------------------------------------------------------
// Public: pruneHandoffs
// ---------------------------------------------------------------------------

/**
 * Remove archive files beyond `keep`. Pointer file is never removed.
 *
 * @param {string} projectRoot
 * @param {{ keep?: number }} options
 * @returns {Promise<{ removed: number }>}
 */
export async function pruneHandoffs(projectRoot, options = {}) {
  if (!projectRoot) return { removed: 0 };
  const keep = resolveKeep(options.keep);
  const all = await listHandoffs(projectRoot);
  if (all.length <= keep) return { removed: 0 };

  const victims = all.slice(keep);
  let removed = 0;
  for (const v of victims) {
    try {
      await unlink(v.path);
      removed += 1;
    } catch {
      // Best-effort: a missing or locked file should not fail the whole prune.
    }
  }
  return { removed };
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

// Internal constants for tests / callers.
export const _internals = Object.freeze({
  HANDOFF_FILE,
  ARCHIVE_DIR,
  POINTER_REL,
  DEFAULT_KEEP,
  DEFAULT_THROTTLE_MS,
});
