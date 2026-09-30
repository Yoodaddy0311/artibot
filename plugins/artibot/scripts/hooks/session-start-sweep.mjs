#!/usr/bin/env node
/**
 * SessionStart sweep hook.
 *
 * Removes orphan atomic-write tempfiles from the runtime state directories that are
 * older than AGE_THRESHOLD_MS (default 60 min), and idle per-session state
 * directories. The `*.tmp.<pid>` / `*.tmp.<pid>.<ts>` artifacts are left behind when a
 * process crashes between `fs.writeFile(tmp)` and `fs.rename(tmp, final)` in the
 * atomic-write helper used by decision-trail.js, first-run-state.js, et al.
 *
 * WHICH DIRECTORIES (O2). Hooks keep GLOBAL state in `<state dir>/runtime/` and SESSION
 * state in `<state dir>/runtime/sessions/<session_id>/`, where `<state dir>` is
 * `resolveArtibotDir()` (`~/.claude/artibot`; `lib/core/runtime-state.js`). Those are
 * swept — the runtime dir and each session dir, ONE level, never deeper. The legacy
 * `<pluginRoot>/runtime/` (where hooks wrote before O2, and still the same directory
 * as the state one under the install.sh layout) is swept too, so droppings left there
 * do not wait for a plugin update to disappear.
 *
 * SESSION DIRECTORIES. After the tmp sweep, `sweepSessionDirs` removes session
 * directories idle longer than 7 days and caps the rest at 256, never the one in this
 * hook's own payload. `session-start.js` runs the same function on every SessionStart;
 * it is repeated here so that registering this hook, as the note below describes,
 * keeps the bound — it does not replace that call.
 *
 * Contract:
 *   - stdin:  JSON (session-start event payload; only `session_id` is read)
 *   - stdout: JSON `{"continue": true}` — never blocks the session
 *   - stderr: human-readable counts when ARTIBOT_DEBUG=1
 *
 * Safety:
 *   - The tmp sweep only touches files matching the `*.tmp.*` suffix pattern
 *     (atomic-write signature). Never touches the final files.
 *   - Skips files younger than AGE_THRESHOLD_MS so a currently-running writer
 *     is not interrupted.
 *   - Swallows all I/O errors; a cleanup hook must never block a session.
 *
 * Hook registration (pending — v0.5.1 roadmap; NOT in hooks/dispatch-table.json as of
 * 2026-09-30, measured — so nothing runs this file today):
 *   Add to `.claude/settings.json` → `hooks.SessionStart`:
 *     {"command": "node plugins/artibot/scripts/hooks/session-start-sweep.mjs"}
 *
 * @module scripts/hooks/session-start-sweep
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeDir, SESSIONS_DIRNAME, sweepSessionDirs } from '../../lib/core/runtime-state.js';
import { isMainEntry } from './_main-entry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Match atomic-write temp suffix: `.tmp.<digits>` optionally `.<digits>`. */
const TMP_SUFFIX = /\.tmp\.\d+(?:\.\d+)?$/;

/** Skip files younger than this (ms) — could still be an in-flight writer. */
const AGE_THRESHOLD_MS = 60 * 60 * 1000;

/** The pre-O2 location: `<pluginRoot>/runtime/`. */
const LEGACY_RUNTIME_DIR = path.resolve(__dirname, '..', '..', 'runtime');

/**
 * The directories whose tmp droppings are swept: the state runtime dir, each session
 * dir under it, and the legacy plugin-root runtime dir (when it is a different one).
 * @returns {string[]}
 */
function sweepTargets() {
  const runtimeDir = resolveRuntimeDir();
  const targets = [runtimeDir];
  const sessionsDir = path.join(runtimeDir, SESSIONS_DIRNAME);
  try {
    for (const name of readdirSync(sessionsDir)) targets.push(path.join(sessionsDir, name));
  } catch {
    // no sessions/ yet
  }
  if (path.resolve(LEGACY_RUNTIME_DIR) !== path.resolve(runtimeDir)) targets.push(LEGACY_RUNTIME_DIR);
  return targets;
}

/**
 * Sweep orphan tmp files. Pure I/O — returns counts for stderr logging.
 * @returns {{ scanned: number, deleted: number, skipped: number }}
 */
function sweepOrphanTmp() {
  const now = Date.now();
  let scanned = 0;
  let deleted = 0;
  let skipped = 0;

  for (const dir of sweepTargets()) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!TMP_SUFFIX.test(name)) continue;
      scanned += 1;
      const full = path.join(dir, name);
      try {
        const { mtimeMs } = statSync(full);
        if (now - mtimeMs < AGE_THRESHOLD_MS) { skipped += 1; continue; }
        unlinkSync(full);
        deleted += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  return { scanned, deleted, skipped };
}

/**
 * Drain stdin (so upstream writers do not EPIPE) and pull the session id out of it.
 * @returns {Promise<string|null>}
 */
async function readSessionId() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const id = JSON.parse(Buffer.concat(chunks).toString('utf-8'))?.session_id;
    return typeof id === 'string' && id.trim() !== '' ? id : null;
  } catch {
    return null;
  }
}

async function main() {
  const sessionId = await readSessionId();

  const result = sweepOrphanTmp();
  const sessions = sweepSessionDirs({ protect: sessionId === null ? [] : [sessionId] });
  if (process.env.ARTIBOT_DEBUG === '1') {
    process.stderr.write(
      `[session-start-sweep] scanned=${result.scanned} deleted=${result.deleted} skipped=${result.skipped}`
      + ` sessions(scanned=${sessions.scanned} removed=${sessions.removed} kept=${sessions.kept})\n`,
    );
  }
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
}

// Direct-run guard: importing this module must not run main(). Without it the
// import holds stdin in the background — invisible to the old import-safety
// probe, which exited the moment module evaluation finished. The dispatcher
// spawns this file as argv[1], so production behavior is unchanged.
if (isMainEntry(import.meta.url)) {
  main().catch(() => {
    // Never block the session on a cleanup failure.
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  });
}
