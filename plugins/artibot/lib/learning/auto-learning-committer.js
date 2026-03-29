/**
 * Auto-Learning Pipeline — Auto-Commit Stage.
 * Handles safe auto-commit with allowlist/denylist guardrails,
 * branch protection, and provenance-enriched commit messages.
 *
 * Extracted from auto-learning-runner.js for file size compliance.
 * Zero runtime deps. ESM only.
 *
 * @module lib/learning/auto-learning-committer
 */

import os from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getPluginRoot } from '../core/platform.js';
import { hashShort } from './auto-learning-extractor.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTECTED_BRANCHES = ['main', 'master'];

/**
 * Files/directories allowed for auto-commit (glob patterns).
 * Only learning data and derived artifacts — never source code.
 */
export const AUTO_COMMIT_ALLOWLIST = Object.freeze([
  'lib/learning/**',
  'lib/cognitive/system1-cache/**',
  'lib/cognitive/system2-cache/**',
  'skills/*/references/**',
  'learning-log.json',
  'patterns/**',
  '.artibot/**',
]);

/**
 * Files/directories explicitly denied from auto-commit (glob patterns).
 * Takes precedence over allowlist.
 */
export const AUTO_COMMIT_DENYLIST = Object.freeze([
  'skills/*/SKILL.md',
  'lib/runtime/**',
  'lib/core/**',
  'lib/adapters/**',
  'lib/privacy/**',
  'lib/visual/**',
  'lib/swarm/**',
  'lib/intent/**',
  'lib/context/**',
  'lib/system/**',
  'agents/**',
  'commands/**',
  'hooks/**',
  'scripts/**',
  'output-styles/**',
  'templates/**',
  'rules/**',
  'tests/**',
  'docs/**',
  'artibot.config.json',
  'package.json',
  'package-lock.json',
  'install.sh',
  '.claude-plugin/**',
  '.mcp.json',
  '.gitignore',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'README.md',
  'CHANGELOG.md',
]);

// ---------------------------------------------------------------------------
// Glob Matcher
// ---------------------------------------------------------------------------

/**
 * Simple glob pattern matcher (zero deps).
 * Supports: `*` (one segment), `**` (any depth), literal segments.
 *
 * @param {string} filePath - Relative file path (forward slashes)
 * @param {string} pattern - Glob pattern
 * @returns {boolean}
 */
export function matchGlob(filePath, pattern) {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const patParts = pattern.replace(/\\/g, '/').split('/');
  return _matchParts(parts, 0, patParts, 0);
}

function _matchParts(parts, pi, pats, qi) {
  if (qi === pats.length) return pi === parts.length;
  if (pi === parts.length) {
    for (let i = qi; i < pats.length; i++) {
      if (pats[i] !== '**') return false;
    }
    return true;
  }

  const pat = pats[qi];

  if (pat === '**') {
    for (let skip = 0; skip <= parts.length - pi; skip++) {
      if (_matchParts(parts, pi + skip, pats, qi + 1)) return true;
    }
    return false;
  }

  if (pat === '*') {
    return _matchParts(parts, pi + 1, pats, qi + 1);
  }

  if (parts[pi] === pat) {
    return _matchParts(parts, pi + 1, pats, qi + 1);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Allowlist / Denylist Filter
// ---------------------------------------------------------------------------

/**
 * Check if a file path is allowed for auto-commit.
 *
 * @param {string} filePath - Relative path from repo root
 * @param {string[]} [allowlist] - Override allowlist
 * @param {string[]} [denylist] - Override denylist
 * @returns {{ allowed: boolean, reason: string }}
 */
export function isAutoCommitAllowed(filePath, allowlist, denylist) {
  const allow = allowlist || AUTO_COMMIT_ALLOWLIST;
  const deny = denylist || AUTO_COMMIT_DENYLIST;
  const normalized = filePath.replace(/\\/g, '/');

  // Denylist takes precedence
  for (const pattern of deny) {
    if (matchGlob(normalized, pattern)) {
      return { allowed: false, reason: `denied by pattern: ${pattern}` };
    }
  }

  // Must match at least one allowlist pattern
  for (const pattern of allow) {
    if (matchGlob(normalized, pattern)) {
      return { allowed: true, reason: `allowed by pattern: ${pattern}` };
    }
  }

  return { allowed: false, reason: 'not in allowlist' };
}

/**
 * Get changed files from git status and filter through allowlist/denylist.
 *
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {string[]} [options.allowlist]
 * @param {string[]} [options.denylist]
 * @returns {Promise<{ allowed: string[], blocked: object[], total: number }>}
 */
export async function getFilteredChanges(options = {}) {
  const cwd = options.cwd || getPluginRoot();

  let allFiles;
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain'], {
      cwd,
      timeout: 10_000,
      encoding: 'utf-8',
    });
    allFiles = stdout.trim().split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return { allowed: [], blocked: [], total: 0 };
  }

  const allowed = [];
  const blocked = [];

  for (const file of allFiles) {
    const result = isAutoCommitAllowed(file, options.allowlist, options.denylist);
    if (result.allowed) {
      allowed.push(file);
    } else {
      blocked.push({ file, reason: result.reason });
    }
  }

  return { allowed, blocked, total: allFiles.length };
}

// ---------------------------------------------------------------------------
// Commit Message Builder
// ---------------------------------------------------------------------------

/**
 * Build auto-commit message with [AUTOMATED] tag and metadata.
 *
 * @param {object} pipelineResult
 * @param {number} allowedCount
 * @param {number} blockedCount
 * @param {object} [provenance] - From collectProvenance()
 * @returns {string}
 */
export function buildAutoCommitMessage(pipelineResult, allowedCount, blockedCount, provenance) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const stages = pipelineResult.stagesRun?.join(', ') ?? 'all';
  const machineHash = provenance?.machineHash || hashShort(os.hostname());
  const version = provenance?.pipelineVersion || '1.15.0';
  const project = provenance?.projectName || 'unknown';

  return [
    `chore(auto-learning): [AUTOMATED] pipeline — ${dateStr}`,
    '',
    `Stages: ${stages}`,
    `Files: ${allowedCount} allowed, ${blockedCount} blocked`,
    `Source: ${project}@${machineHash}`,
    `Pipeline: v${version}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Branch Safety
// ---------------------------------------------------------------------------

/**
 * Check current git branch safety.
 * @param {object} options
 * @param {string} [options.cwd]
 * @returns {Promise<{ branch: string, safe: boolean }>}
 */
export async function checkBranchSafety(options = {}) {
  const cwd = options.cwd || getPluginRoot();
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 10_000,
      encoding: 'utf-8',
    });
    const branch = stdout.trim();
    return { branch, safe: !PROTECTED_BRANCHES.includes(branch) };
  } catch {
    return { branch: 'unknown', safe: false };
  }
}

/**
 * Count uncommitted changes.
 * @param {object} options
 * @param {string} [options.cwd]
 * @returns {Promise<number>}
 */
export async function countChanges(options = {}) {
  const cwd = options.cwd || getPluginRoot();
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain'], {
      cwd,
      timeout: 10_000,
      encoding: 'utf-8',
    });
    return stdout.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Auto-Commit Stage
// ---------------------------------------------------------------------------

/**
 * Auto-commit and optionally push pipeline changes.
 * Uses allowlist/denylist guardrails — only learning data is committed.
 *
 * @param {object} config - autoLearning config
 * @param {object} pipelineResult - Combined results from all stages
 * @param {object} options
 * @param {string} [options.cwd]
 * @returns {Promise<object>} CommitReport
 */
export async function runAutoCommit(config, pipelineResult, options = {}) {
  const cwd = options.cwd || getPluginRoot();
  const report = {
    stage: 'auto-commit',
    timestamp: new Date().toISOString(),
    committed: false,
    pushed: false,
    changesCount: 0,
    allowedCount: 0,
    blockedCount: 0,
    blockedFiles: [],
    aborted: false,
  };

  if (config.dryRun) {
    report.dryRun = true;
    return report;
  }

  if (!config.autoCommit) {
    report.skipped = true;
    return report;
  }

  // Branch safety check
  const { branch, safe } = await checkBranchSafety({ cwd });
  if (!safe) {
    report.aborted = true;
    report.reason = `protected branch: ${branch}`;
    return report;
  }

  // Filter changes through allowlist/denylist
  const customAllowlist = config.allowedPaths || undefined;
  const { allowed, blocked, total } = await getFilteredChanges({
    cwd,
    allowlist: customAllowlist,
  });

  report.changesCount = total;
  report.allowedCount = allowed.length;
  report.blockedCount = blocked.length;
  report.blockedFiles = blocked.slice(0, 20);

  if (allowed.length === 0) {
    report.skipped = true;
    report.reason = blocked.length > 0
      ? `all ${total} changes blocked by guardrail`
      : 'no changes to commit';
    return report;
  }

  if (allowed.length > config.maxChangesPerRun) {
    report.aborted = true;
    report.reason = `allowed changes (${allowed.length}) exceed maxChangesPerRun (${config.maxChangesPerRun})`;
    return report;
  }

  // Stage only allowed files (NOT git add -A)
  const provenance = pipelineResult.provenance || null;
  const commitMsg = buildAutoCommitMessage(pipelineResult, allowed.length, blocked.length, provenance);

  try {
    await execFile('git', ['add', '--', ...allowed], { cwd, timeout: 30_000 });
    await execFile('git', ['commit', '-m', commitMsg], { cwd, timeout: 30_000, encoding: 'utf-8' });
    report.committed = true;
    report.commitMessage = commitMsg;
  } catch (err) {
    report.committed = false;
    report.error = err.message;
    return report;
  }

  // Push
  if (config.autoPush) {
    try {
      await execFile('git', ['push'], { cwd, timeout: 60_000, encoding: 'utf-8' });
      report.pushed = true;
    } catch (err) {
      report.pushed = false;
      report.pushError = err.message;
    }
  }

  return report;
}
