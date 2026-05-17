/**
 * Autopilot per-phase git diff summary.
 *
 * Aggregates checkpoint SHAs recorded per phase into git-numstat-based change
 * stats, used by:
 *   - Phase 6 REPORT generator (auto-inject diff table next to timeline)
 *   - `/autopilot:diff {sessionId}` subcommand (past-session query)
 *
 * DATA POLICY: pure local git read-only (execFileSync of `git diff --numstat`).
 * No remote fetch/push, no external HTTP. Korean-path safe via process.cwd().
 *
 * Public surface:
 *   - diffSession(sessionId, opts?)
 *   - renderDiffTable(summary)
 *
 * @module lib/autopilot/phase-diff
 */

import { execFileSync } from 'node:child_process';
import { loadSession } from './session-store.js';

const TOP_FILES_PER_PHASE = 5;

/**
 * Default git runner — local read-only execFileSync.
 * Throws on non-zero exit; callers catch and degrade gracefully.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} stdout
 */
function defaultGitRunner(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Parse a single numstat line into a file entry. Returns null when malformed.
 * Binary files (`-\t-\tpath`) are counted as 0/0.
 * @param {string} line
 * @returns {{path: string, insertions: number, deletions: number}|null}
 */
function parseNumstatLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed) return null;
  const parts = trimmed.split('\t');
  if (parts.length < 3) return null;
  const ins = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10);
  const del = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10);
  const filePath = parts.slice(2).join('\t');
  if (!filePath) return null;
  return {
    path: filePath,
    insertions: Number.isFinite(ins) ? ins : 0,
    deletions: Number.isFinite(del) ? del : 0,
  };
}

/**
 * Parse full numstat stdout into an array of file entries.
 * @param {string} stdout
 * @returns {Array<{path: string, insertions: number, deletions: number}>}
 */
function parseNumstat(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return [];
  const out = [];
  for (const line of stdout.split('\n')) {
    const entry = parseNumstatLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Pair phases with their (fromSha, toSha) boundaries.
 * - Only checkpoints with a non-empty `sha` are considered.
 * - For each phase, toSha = last checkpoint in that phase.
 * - fromSha = last checkpoint of the previous phase that recorded a SHA.
 * - The very first phase with any SHA has no fromSha → skipped (cannot diff).
 *
 * @param {Array<{phase?: string, sha?: string}>} checkpoints
 * @returns {Array<{phase: string, fromSha: string, toSha: string}>}
 */
function buildPhasePairs(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return [];
  const lastByPhase = new Map(); // phase -> last sha (preserves insertion order)
  for (const cp of checkpoints) {
    if (!cp || typeof cp !== 'object') continue;
    const phase = typeof cp.phase === 'string' && cp.phase ? cp.phase : null;
    const sha = typeof cp.sha === 'string' && cp.sha ? cp.sha : null;
    if (!phase || !sha) continue;
    lastByPhase.set(phase, sha);
  }
  const pairs = [];
  let prevSha = null;
  for (const [phase, toSha] of lastByPhase.entries()) {
    if (prevSha) {
      pairs.push({ phase, fromSha: prevSha, toSha });
    }
    prevSha = toSha;
  }
  return pairs;
}

/**
 * Compute a single phase's diff entry using the provided git runner.
 * Failures degrade to an empty-but-present entry so caller can omit later.
 * @param {{phase: string, fromSha: string, toSha: string}} pair
 * @param {(args: string[], cwd: string) => string} gitRunner
 * @param {string} cwd
 * @returns {{phase, fromSha, toSha, filesChanged, insertions, deletions, topFiles}}
 */
function computePhaseEntry(pair, gitRunner, cwd) {
  const base = {
    phase: pair.phase,
    fromSha: pair.fromSha,
    toSha: pair.toSha,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    topFiles: [],
  };
  let stdout;
  try {
    stdout = gitRunner(['diff', '--numstat', pair.fromSha, pair.toSha], cwd);
  } catch {
    return base;
  }
  const files = parseNumstat(stdout);
  let insertions = 0;
  let deletions = 0;
  for (const f of files) {
    insertions += f.insertions;
    deletions += f.deletions;
  }
  const topFiles = files
    .slice()
    .sort((a, b) => (b.insertions + b.deletions) - (a.insertions + a.deletions))
    .slice(0, TOP_FILES_PER_PHASE);
  return {
    ...base,
    filesChanged: files.length,
    insertions,
    deletions,
    topFiles,
  };
}

/**
 * Compute per-phase git diff summary from session checkpoints.
 *
 * @param {string} sessionId
 * @param {{ gitRunner?: (args: string[], cwd: string) => string, cwd?: string, state?: object }} [opts]
 * @returns {{
 *   sessionId: string,
 *   phases: Array<{
 *     phase: string, fromSha: string, toSha: string,
 *     filesChanged: number, insertions: number, deletions: number,
 *     topFiles: Array<{path: string, insertions: number, deletions: number}>
 *   }>,
 *   totalFilesChanged: number,
 *   totalInsertions: number,
 *   totalDeletions: number
 * }}
 */
export function diffSession(sessionId, opts = {}) {
  const empty = {
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    phases: [],
    totalFilesChanged: 0,
    totalInsertions: 0,
    totalDeletions: 0,
  };
  if (!sessionId || typeof sessionId !== 'string') return empty;
  const gitRunner = typeof opts.gitRunner === 'function' ? opts.gitRunner : defaultGitRunner;
  const cwd = typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : process.cwd();
  let state = opts.state;
  if (!state) {
    try {
      state = loadSession(sessionId);
    } catch {
      state = null;
    }
  }
  if (!state || typeof state !== 'object') return empty;
  const pairs = buildPhasePairs(state.checkpoints);
  if (pairs.length === 0) return empty;
  const phases = [];
  let totalFilesChanged = 0;
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const pair of pairs) {
    const entry = computePhaseEntry(pair, gitRunner, cwd);
    if (entry.filesChanged === 0) continue; // omit no-change phases
    phases.push(entry);
    totalFilesChanged += entry.filesChanged;
    totalInsertions += entry.insertions;
    totalDeletions += entry.deletions;
  }
  return {
    sessionId,
    phases,
    totalFilesChanged,
    totalInsertions,
    totalDeletions,
  };
}

/**
 * Format a single top-file entry as `path (+ins/-del)`.
 * @param {{path: string, insertions: number, deletions: number}} f
 * @returns {string}
 */
function fmtTopFile(f) {
  return `${f.path} (+${f.insertions}/-${f.deletions})`;
}

/**
 * Render diff summary as GFM markdown table string.
 * Returns a brief "no diff" stub if the summary has no phases.
 *
 * @param {object} summary - output of diffSession
 * @returns {string} markdown
 */
export function renderDiffTable(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const phases = Array.isArray(s.phases) ? s.phases : [];
  const header = '## Phase Diff (auto-generated from git checkpoints)';
  if (phases.length === 0) {
    return `${header}\n\n_(diff 데이터 없음 — checkpoint SHA 누락 또는 변경 없음)_`;
  }
  const head = '| Phase | files | +ins | -del | top changes |';
  const sep = '|---|---|---|---|---|';
  const rows = phases.map((p) => {
    const top = Array.isArray(p.topFiles) && p.topFiles.length
      ? p.topFiles.map(fmtTopFile).join(', ')
      : '-';
    return `| ${p.phase} | ${p.filesChanged} | ${p.insertions} | ${p.deletions} | ${top} |`;
  });
  const totalFiles = s.totalFilesChanged || 0;
  const totalIns = s.totalInsertions || 0;
  const totalDel = s.totalDeletions || 0;
  const footer = `\n\n**Total**: ${totalFiles} files, +${totalIns} / -${totalDel}`;
  return `${header}\n\n${[head, sep, ...rows].join('\n')}${footer}`;
}
