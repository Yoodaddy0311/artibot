/**
 * AI conflict resolution engine.
 * Applies positional, compatibility, and semantic strategies to resolve
 * git conflict blocks. Supports snapshot/rollback and verification.
 *
 * @module lib/git/conflict-resolver
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { parseConflictBlocks, splitLines } from './conflict-parser.js';
import { logError } from '../core/error.js';

const execFileAsync = promisify(execFile);

/** @type {string} Minimum confidence threshold to auto-resolve without user input */
const CONFIDENCE_THRESHOLD = 0.75;

/** @type {string} Directory under project root for conflict snapshots */
const SNAPSHOT_DIR = '.artibot/conflict-snapshots';

/**
 * @typedef {Object} ResolutionResult
 * @property {boolean} resolved        - Whether the block was successfully resolved
 * @property {string[]} lines          - Resolved lines (empty on failure)
 * @property {string} strategy         - Which strategy succeeded ('positional'|'compatible'|'semantic'|'none')
 * @property {number} confidence       - Confidence score 0.0–1.0
 * @property {boolean} [needsUserInput] - True when confidence < threshold
 * @property {string[][]} [choices]    - Candidate resolutions when needsUserInput is true
 * @property {string} [reason]         - Why resolution failed (if resolved=false)
 */

/**
 * @typedef {Object} FileResolutionResult
 * @property {boolean} success
 * @property {number} resolved          - Count of resolved blocks
 * @property {number} unresolved        - Count of unresolved blocks
 * @property {string} content           - Resulting file content (may still have markers if unresolved > 0)
 */

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

/**
 * Positional strategy: trivial resolution when sides are identical or one is empty.
 *
 * @param {import('./conflict-parser.js').ConflictBlock} block
 * @returns {ResolutionResult}
 */
export function tryPositional(block) {
  const { ours, theirs } = block;

  // Both sides identical — trivial, maximum confidence.
  if (ours.join('\n') === theirs.join('\n')) {
    return { resolved: true, lines: [...ours], strategy: 'positional', confidence: 1.0 };
  }

  // Blank-only sides — whitespace-only conflict, very safe to merge.
  const oursBlank = ours.every((l) => l.trim() === '');
  const theirsBlank = theirs.every((l) => l.trim() === '');
  if (oursBlank && theirsBlank) {
    const merged = ours.length >= theirs.length ? [...ours] : [...theirs];
    return { resolved: true, lines: merged, strategy: 'positional', confidence: 0.95 };
  }

  // One side empty — take the other.
  if (ours.length === 0) {
    return { resolved: true, lines: [...theirs], strategy: 'positional', confidence: 0.90 };
  }
  if (theirs.length === 0) {
    return { resolved: true, lines: [...ours], strategy: 'positional', confidence: 0.90 };
  }

  return { resolved: false, lines: [], strategy: 'positional', confidence: 0, reason: 'overlapping changes' };
}

/**
 * Compatible strategy: containment check and additive merge.
 *
 * @param {import('./conflict-parser.js').ConflictBlock} block
 * @returns {ResolutionResult}
 */
export function tryCompatible(block) {
  const { ours, theirs, base } = block;

  const oursStr = ours.map((l) => l.trimEnd());
  const theirsStr = theirs.map((l) => l.trimEnd());

  // Containment: one side is a subset of the other — pick superset.
  const oursContainsTheirs = theirsStr.every((l) => oursStr.includes(l));
  const theirsContainsOurs = oursStr.every((l) => theirsStr.includes(l));

  if (oursContainsTheirs && ours.length >= theirs.length) {
    return { resolved: true, lines: [...ours], strategy: 'compatible', confidence: 0.88 };
  }
  if (theirsContainsOurs && theirs.length > ours.length) {
    return { resolved: true, lines: [...theirs], strategy: 'compatible', confidence: 0.88 };
  }

  // Additive merge with base: both sides added different lines on top of base.
  if (Array.isArray(base) && base.length > 0) {
    const baseStr = base.map((l) => l.trimEnd());
    const oursAdded = oursStr.filter((l) => !baseStr.includes(l));
    const theirsAdded = theirsStr.filter((l) => !baseStr.includes(l));
    const oursModified = baseStr.some((l) => !oursStr.includes(l));
    const theirsModified = baseStr.some((l) => !theirsStr.includes(l));

    if (!oursModified || !theirsModified) {
      const merged = [...base, ...oursAdded, ...theirsAdded.filter((l) => !oursAdded.includes(l))];
      return { resolved: true, lines: merged, strategy: 'compatible', confidence: 0.82 };
    }
  }

  // Union (no base) — deduplicated additive merge.
  const oursSet = new Set(oursStr);
  const extra = theirs.filter((l) => !oursSet.has(l.trimEnd()));
  if (extra.length > 0 && extra.length < theirs.length) {
    return { resolved: true, lines: [...ours, ...extra], strategy: 'compatible', confidence: 0.78 };
  }

  return { resolved: false, lines: [], strategy: 'compatible', confidence: 0, reason: 'both sides modified base lines' };
}

/**
 * Semantic strategy: semver comparison, timestamp ordering, value heuristics.
 *
 * @param {import('./conflict-parser.js').ConflictBlock} block
 * @returns {ResolutionResult}
 */
export function trySemantic(block) {
  const { ours, theirs } = block;

  if (ours.length === 1 && theirs.length === 1) {
    const result = resolveSingleLineSemantic(ours[0], theirs[0]);
    if (result) return result;
  }

  return { resolved: false, lines: [], strategy: 'semantic', confidence: 0, reason: 'no semantic rule matched' };
}

/**
 * Apply semantic rules to a pair of single conflicting lines.
 *
 * @param {string} ourLine
 * @param {string} theirLine
 * @returns {ResolutionResult|null}
 */
function resolveSingleLineSemantic(ourLine, theirLine) {
  const semverRe = /(\d+\.\d+\.\d+[-\w.]*)/;
  const oV = semverRe.exec(ourLine);
  const tV = semverRe.exec(theirLine);
  if (oV && tV) {
    const winner = compareSemver(oV[1], tV[1]) >= 0 ? ourLine : theirLine;
    return { resolved: true, lines: [winner], strategy: 'semantic', confidence: 0.85 };
  }

  const isoRe = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  if (isoRe.test(ourLine) && isoRe.test(theirLine)) {
    const winner = ourLine >= theirLine ? ourLine : theirLine;
    return { resolved: true, lines: [winner], strategy: 'semantic', confidence: 0.75 };
  }

  return null;
}

/**
 * Compare two semver strings. Returns positive if a > b, 0 if equal, negative if a < b.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSemver(a, b) {
  const parse = (s) => s.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Block resolution (public API)
// ---------------------------------------------------------------------------

/**
 * Resolve a single conflict block using strategy cascade: positional → compatible → semantic.
 * Sets needsUserInput and choices when confidence < CONFIDENCE_THRESHOLD.
 *
 * @param {import('./conflict-parser.js').ConflictBlock} block
 * @param {string} [_filePath] - Optional file path for context (unused internally, kept for API compat)
 * @returns {ResolutionResult}
 */
export function resolveBlock(block, _filePath) {
  for (const strategy of [tryPositional, tryCompatible, trySemantic]) {
    const result = strategy(block);
    if (result.resolved) {
      if (result.confidence < CONFIDENCE_THRESHOLD) {
        return {
          ...result,
          needsUserInput: true,
          choices: buildChoices(block, result),
        };
      }
      return result;
    }
  }

  return {
    resolved: false,
    lines: [],
    strategy: 'none',
    confidence: 0,
    reason: 'all strategies exhausted',
    needsUserInput: true,
    choices: buildChoices(block, null),
  };
}

/**
 * Build candidate resolution choices for user selection.
 *
 * @param {import('./conflict-parser.js').ConflictBlock} block
 * @param {ResolutionResult|null} attempted
 * @returns {string[][]}
 */
function buildChoices(block, attempted) {
  const choices = [block.ours, block.theirs];
  if (attempted && attempted.lines.length > 0) {
    choices.push(attempted.lines);
  }
  if (Array.isArray(block.base) && block.base.length > 0) {
    choices.push(block.base);
  }
  return choices;
}

// ---------------------------------------------------------------------------
// File resolution (synchronous — used by tests with in-memory content)
// ---------------------------------------------------------------------------

/**
 * Resolve all conflicts in file content and return result.
 * When filePath is a real path and content is omitted, reads from disk.
 * When content is provided, operates entirely in-memory (no disk writes).
 *
 * @param {string} filePath
 * @param {string} [content] - Pre-loaded file content (optional)
 * @returns {FileResolutionResult}
 */
export function resolveFile(filePath, content) {
  let src = content;
  if (src === undefined) {
    try {
      src = readFileSync(filePath, 'utf8');
    } catch (err) {
      logError('conflict-resolver', `Cannot read ${filePath}`, err);
      return { success: false, resolved: 0, unresolved: 0, content: '' };
    }
  }

  const blocks = parseConflictBlocks(src);
  if (blocks.length === 0) {
    return { success: true, resolved: 0, unresolved: 0, content: src };
  }

  const lines = splitLines(src);
  const result = applyResolutions(lines, blocks, filePath);

  const finalContent = result.resolvedContent;
  if (content === undefined && result.unresolvedCount === 0) {
    try {
      writeFileSync(filePath, finalContent, 'utf8');
    } catch (err) {
      logError('conflict-resolver', `Cannot write ${filePath}`, err);
    }
  }

  return {
    success: result.unresolvedCount === 0,
    resolved: blocks.length - result.unresolvedCount,
    unresolved: result.unresolvedCount,
    content: finalContent,
  };
}

/**
 * Apply per-block resolutions to the original line array.
 *
 * @param {string[]} lines
 * @param {import('./conflict-parser.js').ConflictBlock[]} blocks
 * @param {string} filePath
 * @returns {{ resolvedContent: string, unresolvedCount: number }}
 */
function applyResolutions(lines, blocks, filePath) {
  const replacements = new Map();
  let unresolvedCount = 0;

  for (const block of blocks) {
    const result = resolveBlock(block, filePath);
    if (result.resolved && !result.needsUserInput) {
      replacements.set(block.startLine, { endLine: block.endLine, lines: result.lines });
    } else {
      unresolvedCount++;
    }
  }

  const output = [];
  let i = 0;
  while (i < lines.length) {
    if (replacements.has(i)) {
      const { endLine, lines: rLines } = replacements.get(i);
      output.push(...rLines);
      i = endLine + 1;
    } else {
      output.push(lines[i]);
      i++;
    }
  }

  return { resolvedContent: output.join('\n'), unresolvedCount };
}

// ---------------------------------------------------------------------------
// Snapshot / rollback (async, for production use)
// ---------------------------------------------------------------------------

/**
 * Save a snapshot of a file before resolution.
 *
 * @param {string} filePath
 * @param {string} [snapshotDir]
 * @returns {string} Path to the snapshot file
 */
export function saveSnapshot(filePath, snapshotDir = SNAPSHOT_DIR) {
  const timestamp = Date.now();
  const snapFile = join(snapshotDir, `${basename(filePath)}.${timestamp}.snap`);
  mkdirSync(dirname(snapFile), { recursive: true });
  copyFileSync(filePath, snapFile);
  return snapFile;
}

/**
 * Rollback a file to a previously saved snapshot.
 *
 * @param {string} filePath
 * @param {string} snapshotPath
 * @returns {void}
 */
export function rollbackSnapshot(filePath, snapshotPath) {
  if (!existsSync(snapshotPath)) throw new Error(`Snapshot not found: ${snapshotPath}`);
  copyFileSync(snapshotPath, filePath);
}

// ---------------------------------------------------------------------------
// Verification (async)
// ---------------------------------------------------------------------------

/**
 * Run verification commands after resolution. Stops on first failure.
 *
 * @param {string[]} commands
 * @param {string} cwd
 * @returns {Promise<{ passed: boolean, failedCommand: string|null, error: string|null }>}
 */
export async function runVerificationTests(commands, cwd) {
  for (const cmd of commands) {
    const [bin, ...args] = cmd.split(' ');
    try {
      await execFileAsync(bin, args, { cwd, timeout: 30_000 });
    } catch (err) {
      return { passed: false, failedCommand: cmd, error: err.message };
    }
  }
  return { passed: true, failedCommand: null, error: null };
}

// ---------------------------------------------------------------------------
// Summary reporting
// ---------------------------------------------------------------------------

/**
 * Format a human-readable resolution summary.
 * Input items: { file, resolved, unresolved, strategy, stashRef? }
 *
 * @param {Array<{ file: string, resolved: number, unresolved: number, strategy: string, stashRef?: string }>} results
 * @returns {string}
 */
export function formatResolutionSummary(results) {
  if (results.length === 0) {
    return '## Conflict Resolution Summary\n\nNo files processed.';
  }

  const lines = ['## Conflict Resolution Summary', ''];
  let totalResolved = 0;
  let totalUnresolved = 0;

  for (const r of results) {
    totalResolved += r.resolved ?? 0;
    totalUnresolved += r.unresolved ?? 0;

    const icon = (r.unresolved ?? 0) > 0 ? '⚠' : '✓';
    lines.push(`${icon} ${r.file} [${r.strategy ?? 'mixed'}]`);
    lines.push(`  resolved: ${r.resolved ?? 0}, unresolved: ${r.unresolved ?? 0}`);

    if (r.stashRef) {
      lines.push(`  rollback: git stash pop ${r.stashRef}`);
    }

    lines.push('');
  }

  lines.push(`Total: ${totalResolved} resolved, ${totalUnresolved} unresolved`);
  return lines.join('\n');
}
