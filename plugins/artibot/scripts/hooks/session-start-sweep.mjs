#!/usr/bin/env node
/**
 * SessionStart sweep hook.
 *
 * Removes orphan atomic-write tempfiles from `plugins/artibot/runtime/` that
 * older than AGE_THRESHOLD_MS (default 60 min). These `*.tmp.<pid>` /
 * `*.tmp.<pid>.<ts>` artifacts are left behind when the process crashes
 * between `fs.writeFile(tmp)` and `fs.rename(tmp, final)` in the atomic-write
 * helper used by decision-trail.js, first-run-state.js, et al.
 *
 * Contract:
 *   - stdin:  JSON (session-start event payload; currently unused)
 *   - stdout: JSON `{"continue": true}` — never blocks the session
 *   - stderr: human-readable counts when ARTIBOT_DEBUG=1
 *
 * Safety:
 *   - Only touches files matching the `*.tmp.*` suffix pattern (atomic-write
 *     signature). Never recurses. Never touches the final files.
 *   - Skips files younger than AGE_THRESHOLD_MS so a currently-running writer
 *     is not interrupted.
 *   - Swallows all I/O errors; a cleanup hook must never block a session.
 *
 * Hook registration (pending — v0.5.1 roadmap):
 *   Add to `.claude/settings.json` → `hooks.SessionStart`:
 *     {"command": "node plugins/artibot/scripts/hooks/session-start-sweep.mjs"}
 *
 * @module scripts/hooks/session-start-sweep
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Match atomic-write temp suffix: `.tmp.<digits>` optionally `.<digits>`. */
const TMP_SUFFIX = /\.tmp\.\d+(?:\.\d+)?$/;

/** Skip files younger than this (ms) — could still be an in-flight writer. */
const AGE_THRESHOLD_MS = 60 * 60 * 1000;

/** Absolute path to `plugins/artibot/runtime/`. */
const RUNTIME_DIR = path.resolve(__dirname, '..', '..', 'runtime');

/**
 * Sweep orphan tmp files. Pure I/O — returns counts for stderr logging.
 * @returns {{ scanned: number, deleted: number, skipped: number }}
 */
function sweepOrphanTmp() {
  const now = Date.now();
  let scanned = 0;
  let deleted = 0;
  let skipped = 0;

  let entries;
  try {
    entries = readdirSync(RUNTIME_DIR);
  } catch {
    return { scanned, deleted, skipped };
  }

  for (const name of entries) {
    if (!TMP_SUFFIX.test(name)) continue;
    scanned += 1;
    const full = path.join(RUNTIME_DIR, name);
    try {
      const { mtimeMs } = statSync(full);
      if (now - mtimeMs < AGE_THRESHOLD_MS) { skipped += 1; continue; }
      unlinkSync(full);
      deleted += 1;
    } catch {
      skipped += 1;
    }
  }
  return { scanned, deleted, skipped };
}

async function main() {
  // Drain stdin so upstream writers do not EPIPE; payload currently unused.
  for await (const _chunk of process.stdin) { void _chunk; }

  const result = sweepOrphanTmp();
  if (process.env.ARTIBOT_DEBUG === '1') {
    process.stderr.write(
      `[session-start-sweep] scanned=${result.scanned} deleted=${result.deleted} skipped=${result.skipped}\n`,
    );
  }
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
}

main().catch(() => {
  // Never block the session on a cleanup failure.
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
});
