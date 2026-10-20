/**
 * Sweep of stale read-tracking files from the temp dir.
 *
 * `scripts/hooks/pre-write-guard.js` keeps one `artibot-read-tracking-<session>.json` per session in
 * `os.tmpdir()` so the PreToolUse write guard (a separate process) can see what the PostToolUse Read hook
 * recorded. Nothing ever removed them: a 2026-10-20 count on the owner's machine found 295 files (1.9 MB),
 * 277 of them older than 7 days, the oldest from August.
 *
 * @module lib/core/read-tracking-sweep
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Tracking files are named after the session; nothing else in the temp dir uses this prefix. */
export const TRACKING_PREFIX = 'artibot-read-tracking-';

/** A tracking file untouched for this long belongs to a session that is long over. */
export const TRACKING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Remove stale `artibot-read-tracking-*.json` files from a temp dir.
 *
 * Only regular files named `artibot-read-tracking-*.json` whose mtime is OLDER than `maxAgeMs` go. A
 * missing or unreadable directory and a file that vanishes mid-sweep are not errors: the tidy-up is best
 * effort and never blocks a hook. A session resumed after that long finds its file gone and falls back to
 * the guard's documented degraded mode (approve with a warning) until files are read again.
 *
 * @param {{ dir?: string, now?: number, maxAgeMs?: number }} [options]
 * @returns {number} how many files were removed
 */
export function pruneStaleTrackingFiles({ dir = os.tmpdir(), now = Date.now(), maxAgeMs = TRACKING_MAX_AGE_MS } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(TRACKING_PREFIX) || !name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile() || now - st.mtimeMs <= maxAgeMs) continue;
      unlinkSync(full);
      removed += 1;
    } catch {
      // vanished or held by another process: leave it, the next sweep tries again
    }
  }
  return removed;
}
