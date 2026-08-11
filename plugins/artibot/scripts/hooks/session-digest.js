#!/usr/bin/env node
/**
 * SessionStart digest hook.
 *
 * Emits a one-line "What changed since last session?" summary covering:
 *   - latest auto-learning pattern timestamp
 *   - swarm sync status
 *   - team mode (auto-team triggers)
 *   - count of pending tasks
 *
 * Output is purely informational (additionalContext) so it never blocks
 * session start. All errors are caught and surface as a tiny "digest unavailable"
 * line — never break the user's session.
 *
 * Hook attachment (hooks.json): SessionStart
 * Stdin: Claude Code hook data JSON
 * Stdout: { hookSpecificOutput: { hookEventName, additionalContext } }
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'; // eslint-disable-line sort-imports
import path from 'node:path';
import { ARTIBOT_DIR } from '../../lib/core/config.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { readStdin, writeStdout } from '../utils/index.js';
import { isMainEntry } from './_main-entry.js';

const PATHS = {
  swarmState: path.join(ARTIBOT_DIR, 'swarm-sync-state.json'),
  patternsDir: path.join(ARTIBOT_DIR, 'patterns'),
};

function safeReadJson(p) {
  try {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function formatRelative(isoOrTs) {
  if (!isoOrTs) return 'never';
  const ms = typeof isoOrTs === 'number' ? isoOrTs : Date.parse(isoOrTs);
  if (!Number.isFinite(ms)) return 'unknown';
  const diff = Date.now() - ms;
  const d = Math.floor(diff / 86400000);
  if (d > 0) return `${d}d ago`;
  const h = Math.floor(diff / 3600000);
  if (h > 0) return `${h}h ago`;
  const m = Math.floor(diff / 60000);
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function summarizeSwarm() {
  const s = safeReadJson(PATHS.swarmState);
  if (!s) return { lastUpload: 'never', uploads: 0 };
  return {
    lastUpload: formatRelative(s.lastUpload),
    uploads: s.totalUploads ?? 0,
  };
}

function summarizeLatestPattern() {
  try {
    if (!existsSync(PATHS.patternsDir)) return { last: 'none' };
    const files = readdirSync(PATHS.patternsDir).filter((f) => /^auto-learn-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    if (files.length === 0) return { last: 'none' };
    files.sort();
    const newest = files[files.length - 1];
    const stat = statSync(path.join(PATHS.patternsDir, newest));
    return { last: formatRelative(stat.mtimeMs) };
  } catch {
    return { last: 'unknown' };
  }
}

export async function main() {
  try {
    await readStdin();

    const swarm = summarizeSwarm();
    const pat = summarizeLatestPattern();

    const line = `[Artibot] Learning: Patterns last ${pat.last} | Swarm: ${swarm.uploads} uploads (last ${swarm.lastUpload})`;

    writeStdout({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: line,
      },
    });
  } catch {
    writeStdout({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '[Artibot] Session digest unavailable.',
      },
    });
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('session-digest', { exit: true }));
}
