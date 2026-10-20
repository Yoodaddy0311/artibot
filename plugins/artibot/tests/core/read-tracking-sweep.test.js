import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneStaleTrackingFiles, TRACKING_MAX_AGE_MS, TRACKING_PREFIX } from '../../lib/core/read-tracking-sweep.js';

/**
 * Stale read-tracking files are swept from the temp dir.
 *
 * `scripts/hooks/pre-write-guard.js` keeps one `artibot-read-tracking-<session>.json` per session in
 * `os.tmpdir()` so that the PreToolUse write guard (a separate process) can see what the PostToolUse Read
 * hook recorded. Nothing ever removed them: a 2026-10-20 count on the owner's machine found 295 files
 * (1.9 MB), 277 of them older than 7 days, the oldest from August.
 *
 * WHAT IS PINNED. Only files named `artibot-read-tracking-*.json` are candidates; only regular files; the
 * age test is "older than maxAge", so a file exactly at the limit stays; a missing or unreadable dir is not
 * an error.
 *
 * WHAT THIS FILE CANNOT SEE: the hook wiring (when the sweep runs) — see
 * `tests/hooks/pre-write-guard-tracking-sweep.test.js` for a real child process. Nor a session resumed after
 * more than 7 days: its tracking file is gone, so the guard falls back to its documented degraded mode
 * (approve with a warning) until files are read again.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

function touch(file, ageMs) {
  writeFileSync(file, '[]', 'utf-8');
  const when = new Date(NOW - ageMs);
  utimesSync(file, when, when);
}

describe('pruneStaleTrackingFiles', () => {
  let dir;

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-sweep-')));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('uses the file name the write guard uses and a 7 day limit', () => {
    expect(TRACKING_PREFIX).toBe('artibot-read-tracking-');
    expect(TRACKING_MAX_AGE_MS).toBe(7 * DAY);
  });

  it('removes tracking files older than 7 days and keeps younger ones', () => {
    touch(path.join(dir, 'artibot-read-tracking-old.json'), 8 * DAY);
    touch(path.join(dir, 'artibot-read-tracking-older.json'), 70 * DAY);
    touch(path.join(dir, 'artibot-read-tracking-fresh.json'), 1 * DAY);
    touch(path.join(dir, 'artibot-read-tracking-hour.json'), 60 * 60 * 1000);

    const removed = pruneStaleTrackingFiles({ dir, now: NOW });

    expect(removed).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['artibot-read-tracking-fresh.json', 'artibot-read-tracking-hour.json']);
  });

  it('keeps a file exactly at the limit (older than, not at least as old as)', () => {
    touch(path.join(dir, 'artibot-read-tracking-edge.json'), 7 * DAY);

    expect(pruneStaleTrackingFiles({ dir, now: NOW })).toBe(0);
    expect(existsSync(path.join(dir, 'artibot-read-tracking-edge.json'))).toBe(true);
  });

  it('never touches files that only look similar', () => {
    for (const name of [
      'other.json',
      'artibot-read-tracking.json',
      'artibot-read-tracking-x.txt',
      'my-artibot-read-tracking-x.json',
      'artibot-state.json',
    ]) {
      touch(path.join(dir, name), 90 * DAY);
    }
    mkdirSync(path.join(dir, 'artibot-read-tracking-dir.json'));
    const before = readdirSync(dir).sort();

    expect(pruneStaleTrackingFiles({ dir, now: NOW })).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it('honours a custom maxAgeMs', () => {
    touch(path.join(dir, 'artibot-read-tracking-a.json'), 2 * DAY);

    expect(pruneStaleTrackingFiles({ dir, now: NOW, maxAgeMs: DAY })).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is not an error when the directory does not exist', () => {
    expect(pruneStaleTrackingFiles({ dir: path.join(dir, 'missing'), now: NOW })).toBe(0);
  });
});
