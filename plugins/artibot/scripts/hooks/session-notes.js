#!/usr/bin/env node
/**
 * Session Notes — Stop hook (v4.7.8+).
 *
 * Appends a timeline entry to `<repo>/.artibot/SESSION-NOTES.md` whenever a
 * session ends with new commits / file changes / squashed WIPs. Skips
 * silently for read-only sessions to avoid file pollution.
 *
 * Companion to the auto-memory system — see lib/learning/session-notes.js
 * for the rationale split (memory = permanent facts, this file = timeline).
 *
 * Gated by `isAutopilotAllowed`: only writes inside repos on the allowlist
 * (artibot plugin repo itself + user-added ones). Other repos see zero
 * artifacts.
 *
 * @module scripts/hooks/session-notes
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseJSON, readStdin } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { isAutopilotAllowed } from '../../lib/autopilot/repo-identity.js';
import {
  buildAppendBlock,
  fileHeader,
  shouldSkipEntry,
} from '../../lib/learning/session-notes.js';
import {
  buildFailurePatternSurface,
  replaceSurfaceBlock,
} from '../../lib/learning/failure-pattern-surfacer.js';
import { fileURLToPath } from 'node:url';

// Cap commits per entry — guards against the first-ever run after a fresh
// clone where `git log` could otherwise dump hundreds of historical entries.
const MAX_COMMITS_PER_ENTRY = 20;

// Lookback window when there is no prior state file. Keeps the first entry
// scoped to "today" rather than the entire repo history.
const FIRST_RUN_LOOKBACK = '24 hours ago';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Run `git` with argv-array (shell-free) and return trimmed stdout.
 * Returns empty string on failure so callers can keep going.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Resolve repo root via git rev-parse.
 * @returns {string|null}
 */
function getRepoRoot() {
  const out = git(['rev-parse', '--show-toplevel'], process.cwd());
  return out || null;
}

/**
 * Read session-notes state. Tracks the last commit SHA we recorded so the
 * next entry only contains NEW commits.
 *
 * @param {string} stateFile
 * @returns {{lastSeenSha: string|null}}
 */
function loadState(stateFile) {
  if (!existsSync(stateFile)) return { lastSeenSha: null };
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8'));
  } catch {
    return { lastSeenSha: null };
  }
}

/**
 * Persist session-notes state atomically.
 * @param {string} stateFile
 * @param {object} state
 */
function saveState(stateFile, state) {
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Collect commits between lastSeenSha (exclusive) and HEAD (inclusive).
 * Falls back to FIRST_RUN_LOOKBACK when there's no state.
 *
 * @param {string} repoRoot
 * @param {string|null} lastSeenSha
 * @returns {Array<{sha:string, subject:string}>}
 */
function collectCommits(repoRoot, lastSeenSha) {
  const range = lastSeenSha
    ? `${lastSeenSha}..HEAD`
    : `HEAD --since=${JSON.stringify(FIRST_RUN_LOOKBACK)}`;
  // `--format=%H%x09%s` → SHA TAB subject (TAB-safe separator).
  const args = lastSeenSha
    ? ['log', range, '--format=%H%x09%s', `-${MAX_COMMITS_PER_ENTRY}`]
    : ['log', 'HEAD', `--since=${FIRST_RUN_LOOKBACK}`, '--format=%H%x09%s', `-${MAX_COMMITS_PER_ENTRY}`];
  const raw = git(args, repoRoot);
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return null;
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  }).filter(Boolean);
}

/**
 * Count unique files touched across the given commit range.
 *
 * @param {string} repoRoot
 * @param {string|null} lastSeenSha
 * @returns {number}
 */
function countFilesChanged(repoRoot, lastSeenSha) {
  if (!lastSeenSha) return 0;
  const raw = git(['diff', '--name-only', `${lastSeenSha}..HEAD`], repoRoot);
  if (!raw) return 0;
  return raw.split('\n').filter(Boolean).length;
}

/**
 * Count WIP commits squashed by the close hook. Inspects recent commit
 * messages for the `wip: artibot auto-save` signature.
 *
 * @param {string} repoRoot
 * @param {string|null} lastSeenSha
 * @returns {number}
 */
function countWipSquashed(repoRoot, lastSeenSha) {
  if (!lastSeenSha) return 0;
  // squashed commits ARE removed from history (the squash subject takes their
  // place), so we infer count by looking for an "Includes N WIP commits"
  // marker in the most recent commit messages between lastSeenSha and HEAD.
  const raw = git(
    ['log', `${lastSeenSha}..HEAD`, '--format=%B', `-${MAX_COMMITS_PER_ENTRY}`],
    repoRoot,
  );
  if (!raw) return 0;
  const match = raw.match(/Includes (\d+) WIP commit/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Get the current branch.
 * @param {string} repoRoot
 * @returns {string}
 */
function getCurrentBranch(repoRoot) {
  return git(['branch', '--show-current'], repoRoot) || 'HEAD';
}

/**
 * Get the latest commit SHA on HEAD.
 * @param {string} repoRoot
 * @returns {string|null}
 */
function getHeadSha(repoRoot) {
  return git(['rev-parse', 'HEAD'], repoRoot) || null;
}

/**
 * A↔B bridge: surface the curated top-N failure patterns into the
 * model-visible SESSION-NOTES.md. The block sits directly under the file
 * header and is refreshed (not stacked) on every write via sentinel markers.
 *
 * Best-effort + read-only on the dictionary — any failure here must not block
 * the timeline append that already happened.
 *
 * @param {string} notesFile absolute path to SESSION-NOTES.md
 * @param {string} repoRoot repo root (dictionary lives at <root>/.artibot/...)
 */
async function surfaceFailurePatterns(notesFile, repoRoot) {
  let block;
  try {
    block = await buildFailurePatternSurface({ cwd: repoRoot });
  } catch {
    return; // dictionary missing/unreadable — surface nothing
  }
  if (!block) return;

  let current;
  try {
    current = readFileSync(notesFile, 'utf-8');
  } catch {
    return;
  }

  // Refresh an existing block in place (idempotent), else insert after the
  // header explainer (first '---\n\n' boundary) so it stays near the top.
  const replaced = replaceSurfaceBlock(current, block);
  let next;
  if (replaced !== null) {
    next = replaced;
  } else {
    const marker = '---\n\n';
    const idx = current.indexOf(marker);
    next = idx === -1
      ? `${current}\n${block}\n`
      : `${current.slice(0, idx + marker.length)}${block}\n\n${current.slice(idx + marker.length)}`;
  }

  if (next !== current) {
    try {
      writeFileSync(notesFile, next, 'utf-8');
    } catch {
      // non-fatal
    }
  }
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const repoRoot = getRepoRoot();
  if (!repoRoot) return;

  // Capture-only gate: only write notes inside artibot-allowed repos.
  if (!isAutopilotAllowed(repoRoot)) return;

  const notesDir = path.join(repoRoot, '.artibot');
  const notesFile = path.join(notesDir, 'SESSION-NOTES.md');
  const stateFile = path.join(repoRoot, '.git', 'session-notes-state.json');

  const state = loadState(stateFile);
  const commits = collectCommits(repoRoot, state.lastSeenSha);
  const filesChanged = countFilesChanged(repoRoot, state.lastSeenSha);
  const wipSquashed = countWipSquashed(repoRoot, state.lastSeenSha);

  const meta = {
    timestamp: new Date().toISOString(),
    branch: getCurrentBranch(repoRoot),
    commits,
    filesChanged,
    wipSquashed,
  };

  if (shouldSkipEntry(meta)) return;

  // Ensure the notes directory exists + file has header on first write.
  if (!existsSync(notesDir)) mkdirSync(notesDir, { recursive: true });
  if (!existsSync(notesFile)) writeFileSync(notesFile, fileHeader(), 'utf-8');

  appendFileSync(notesFile, buildAppendBlock(meta), 'utf-8');

  // Persist state + emit the observability line BEFORE the async bridge so the
  // critical timeline bookkeeping is fully synchronous and cannot be lost to a
  // bridge await (losing lastSeenSha would duplicate the entry next run).
  const headSha = getHeadSha(repoRoot);
  if (headSha) saveState(stateFile, { lastSeenSha: headSha });

  process.stderr.write(
    `[artibot:session-notes] Appended entry to ${notesFile} `
    + `(${commits.length} commit(s), ${filesChanged} file(s))\n`,
  );

  // A↔B bridge (last, best-effort): refresh the model-visible failure-patterns
  // block. Wrapped so a bridge failure never propagates out of main().
  try {
    await surfaceFailurePatterns(notesFile, repoRoot);
  } catch {
    // non-fatal
  }

  void hookData;
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(createErrorHandler('session-notes', { exit: true }));
}
