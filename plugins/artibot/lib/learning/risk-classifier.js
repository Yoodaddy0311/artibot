/**
 * Risk Classifier — AGO Self-Control Wave 1 Module 1.
 *
 * Classifies git diffs into risk levels (low/medium/high/critical) so the
 * auto-commit and auto-cleanup runners can refuse anything above the policy
 * ceiling (default: `low`). Pure analysis — no filesystem, git or network I/O.
 *
 * Rule of thumb: when ambiguous, return the HIGHER severity. Safety first.
 *
 * Inputs are plain objects (typically produced by the runner from
 * `git status --porcelain` + `git diff --numstat`). See `classifyDiff` JSDoc.
 *
 * @module lib/learning/risk-classifier
 */

// ---------------------------------------------------------------------------
// Constants (pattern tables)
// ---------------------------------------------------------------------------

/**
 * Paths whose modification is *always* treated as critical regardless of
 * line-count. These are project-wide contracts.
 */
const CRITICAL_EXACT = Object.freeze([
  'package.json',
  'package-lock.json',
  'artibot.config.json',
  '.claude-plugin/plugin.json',
  'hooks.json',
]);

/** Regex hints that imply schema / migration / DB work. */
const CRITICAL_PATTERNS = Object.freeze([
  /(^|\/)migrations?\//i,
  /(^|\/)schema\.(sql|prisma|js|ts)$/i,
  /hooks\.json$/i,
]);

/** Regex patterns that imply agent contracts / public lib surface. */
const HIGH_PATTERNS = Object.freeze([
  /^agents\/[^/]+\.md$/i,
  /^commands\/[^/]+\.md$/i,
  /^skills\/[^/]+\.md$/i,
]);

/** Low-risk extensions — doc / format only. */
const LOW_EXTENSIONS = Object.freeze(['.md', '.mdx', '.txt', '.markdown']);

/** Directories whose contents are low-risk when content-only. */
const LOW_DIRS = Object.freeze(['docs/', 'README']);

// Severity rank used when merging multiple files' results.
const RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const RANK_TO_LEVEL = Object.freeze(['low', 'medium', 'high', 'critical']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize Windows back-slashes to POSIX for pattern matching. */
function toPosix(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/');
}

function hasExtension(filePath, exts) {
  const lower = filePath.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}

function startsWithAny(filePath, prefixes) {
  return prefixes.some((p) => filePath.startsWith(p) || filePath.includes(`/${p}`));
}

/**
 * Detect "formatting only" intent by inspecting hunks. A hunk is considered
 * format-only when it only adds/removes whitespace, semicolons, or trailing
 * commas. Absent hunk data we conservatively return false.
 *
 * @param {object} file
 * @returns {boolean}
 */
function isFormatOnly(file) {
  const hunks = Array.isArray(file?.hunks) ? file.hunks : null;
  if (!hunks || hunks.length === 0) return false;
  for (const h of hunks) {
    const lines = Array.isArray(h?.lines) ? h.lines : [];
    for (const line of lines) {
      if (typeof line !== 'string') return false;
      if (!line.startsWith('+') && !line.startsWith('-')) continue;
      const body = line.slice(1);
      // Treat only whitespace / lone `;` / trailing `,` as format changes.
      if (!/^\s*[;,]?\s*$/.test(body)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function matchCritical(p) {
  if (CRITICAL_EXACT.includes(p) || CRITICAL_EXACT.includes(p.split('/').pop())) {
    return { level: 'critical', score: 1.0, reason: `critical config: ${p}` };
  }
  for (const re of CRITICAL_PATTERNS) {
    if (re.test(p)) {
      return { level: 'critical', score: 1.0, reason: `schema/migration path: ${p}` };
    }
  }
  return null;
}

function matchHigh(p, status) {
  const isLib = p.startsWith('lib/') || p.includes('/lib/');
  const isAddOrDelete = status === 'A' || status === 'D';
  if (isLib && isAddOrDelete) {
    return { level: 'high', score: 0.85, reason: `lib file ${status === 'A' ? 'added' : 'deleted'}` };
  }
  for (const re of HIGH_PATTERNS) {
    if (re.test(p)) {
      return { level: 'high', score: 0.8, reason: `public contract file: ${p}` };
    }
  }
  return null;
}

function matchLow(p, file) {
  if (hasExtension(p, LOW_EXTENSIONS) || startsWithAny(p, LOW_DIRS)) {
    return { level: 'low', score: 0.1, reason: 'docs/markdown change' };
  }
  if (isFormatOnly(file)) {
    return { level: 'low', score: 0.15, reason: 'formatting-only change' };
  }
  return null;
}

function matchMedium(p, add, del) {
  const isLib = p.startsWith('lib/') || p.includes('/lib/');
  const isTests = p.startsWith('tests/');
  const isHooks = p.startsWith('hooks/') || p.includes('/hooks/');
  if (!isLib && !isTests && !isHooks) return null;
  const churn = add + del;
  const score = Math.min(0.75, 0.3 + churn / 400);
  return { level: 'medium', score, reason: `code modification (${add}+/${del}-)` };
}

/**
 * Score a single file change.
 * Returns `{ level, score, reason }`. `score` is 0.0-1.0 (higher = riskier).
 *
 * Unknown patterns deliberately resolve to `medium` (safety rail).
 *
 * @param {{path: string, additions?: number, deletions?: number, status?: string, hunks?: Array}} file
 * @returns {{level: 'low'|'medium'|'high'|'critical', score: number, reason: string}}
 */
export function scoreFile(file) {
  if (!file || typeof file !== 'object' || typeof file.path !== 'string') {
    return { level: 'medium', score: 0.5, reason: 'invalid file descriptor' };
  }

  const p = toPosix(file.path);
  const status = typeof file.status === 'string' ? file.status : 'M';
  const add = Number.isFinite(file.additions) ? file.additions : 0;
  const del = Number.isFinite(file.deletions) ? file.deletions : 0;

  return (
    matchCritical(p) ||
    matchHigh(p, status) ||
    matchLow(p, file) ||
    matchMedium(p, add, del) ||
    { level: 'medium', score: 0.5, reason: `unknown pattern: ${p}` }
  );
}

/**
 * Classify an entire diff. Returns the HIGHEST severity across all files.
 *
 * @param {{files: Array}} diff
 * @returns {{level: 'low'|'medium'|'high'|'critical', score: number, reasons: string[]}}
 */
export function classifyDiff(diff) {
  const files = Array.isArray(diff?.files) ? diff.files : [];
  if (files.length === 0) {
    return { level: 'low', score: 0, reasons: ['no file changes'] };
  }

  let maxRank = 0;
  let maxScore = 0;
  const reasons = [];

  for (const file of files) {
    const s = scoreFile(file);
    const rank = RANK[s.level] ?? 1;
    if (rank > maxRank) maxRank = rank;
    if (s.score > maxScore) maxScore = s.score;
    reasons.push(`${toPosix(file?.path || '?')}: ${s.level} — ${s.reason}`);
  }

  return {
    level: RANK_TO_LEVEL[maxRank],
    score: Math.round(maxScore * 100) / 100,
    reasons,
  };
}

/**
 * Compare two risk levels. Returns true if `level` is within the allowed
 * ceiling `maxLevel` (inclusive).
 *
 * @param {string} level
 * @param {string} maxLevel
 * @returns {boolean}
 */
export function isWithinRiskCeiling(level, maxLevel) {
  const a = RANK[level];
  const b = RANK[maxLevel];
  if (a === undefined || b === undefined) return false;
  return a <= b;
}
