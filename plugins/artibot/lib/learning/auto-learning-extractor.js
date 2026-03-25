/**
 * Auto-Learning Pipeline — Pattern Extract Stage + Provenance Tracking.
 * Analyzes recent git commits for recurring patterns, error trends,
 * and hot files. Collects provenance metadata with PII protection.
 *
 * Extracted from auto-learning-runner.js for file size compliance.
 * Zero runtime deps. ESM only.
 *
 * @module lib/learning/auto-learning-extractor
 */

import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readJsonFile } from '../core/file.js';
import { getPluginRoot } from '../core/platform.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Provenance Helpers
// ---------------------------------------------------------------------------

/**
 * Hash a string with SHA-256 and return the first 8 hex chars.
 * Used for PII protection (email, hostname).
 * @param {string} value
 * @returns {string}
 */
export function hashShort(value) {
  if (!value || typeof value !== 'string') return 'unknown';
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Read a single git config value.
 * @param {string} key - e.g. 'user.name'
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function gitConfigValue(key, cwd) {
  try {
    const { stdout } = await execFile('git', ['config', key], {
      cwd,
      timeout: 5_000,
      encoding: 'utf-8',
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Collect provenance metadata for the current pipeline run.
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {string} [options.firstCommit] - Oldest commit hash in range
 * @param {string} [options.lastCommit] - Newest commit hash in range
 * @returns {Promise<object>} Provenance object
 */
export async function collectProvenance(options = {}) {
  const cwd = options.cwd || getPluginRoot();

  const [userName, userEmail, remoteUrl] = await Promise.all([
    gitConfigValue('user.name', cwd),
    gitConfigValue('user.email', cwd),
    gitConfigValue('remote.origin.url', cwd),
  ]);

  // Get branch separately (not a config value)
  let currentBranch = '';
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, timeout: 5_000, encoding: 'utf-8',
    });
    currentBranch = stdout.trim();
  } catch {
    // ignore
  }

  // Extract project name from remote URL
  const projectName = remoteUrl
    ? path.basename(remoteUrl.replace(/\.git$/, ''))
    : path.basename(cwd);

  const hostname = os.hostname();

  // Read version from config
  let pipelineVersion = '1.14.0';
  try {
    const configPath = path.join(getPluginRoot(), 'artibot.config.json');
    const config = await readJsonFile(configPath);
    pipelineVersion = config?.version ?? pipelineVersion;
  } catch {
    // use default
  }

  const firstCommit = options.firstCommit || '';
  const lastCommit = options.lastCommit || '';
  const commitRange = (firstCommit && lastCommit)
    ? `${firstCommit.slice(0, 7)}..${lastCommit.slice(0, 7)}`
    : '';

  return {
    user: userName,
    emailHash: hashShort(userEmail),
    project: remoteUrl,
    projectName,
    machineHash: hashShort(hostname),
    branch: currentBranch,
    commitRange,
    extractedAt: new Date().toISOString(),
    pipelineVersion,
  };
}

/**
 * Strip PII fields from provenance for Swarm sharing.
 * Removes user, emailHash, machineHash; keeps project-level metadata.
 * @param {object} provenance
 * @returns {object} Sanitized provenance
 */
export function stripProvenancePII(provenance) {
  if (!provenance) return {};
  const { user: _u, emailHash: _e, machineHash: _m, ...safe } = provenance;
  return safe;
}

// ---------------------------------------------------------------------------
// Pattern Extract Stage
// ---------------------------------------------------------------------------

/**
 * Extract patterns from recent git commits.
 * @param {object} options
 * @param {string} [options.since] - Git log time window (default: "24 hours ago")
 * @param {string} [options.cwd] - Working directory
 * @returns {Promise<object>} PatternReport
 */
export async function runPatternExtract(options = {}) {
  const cwd = options.cwd || getPluginRoot();
  const since = options.since || '24 hours ago';
  const report = {
    stage: 'pattern-extract',
    timestamp: new Date().toISOString(),
    commits: [],
    patterns: [],
    hotFiles: [],
    errorTrends: [],
  };

  // Get recent commits
  try {
    const { stdout } = await execFile(
      'git',
      ['log', `--since=${since}`, '--format=%H|%s|%an|%aI', '--no-merges'],
      { cwd, timeout: 30_000, encoding: 'utf-8' },
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    report.commits = lines.map((line) => {
      const [hash, subject, author, date] = line.split('|');
      return { hash, subject, author, date };
    });
  } catch {
    report.commits = [];
  }

  // Classify commit patterns
  const typeCounters = { feat: 0, fix: 0, refactor: 0, chore: 0, docs: 0, test: 0, other: 0 };
  for (const commit of report.commits) {
    const match = commit.subject.match(/^(feat|fix|refactor|chore|docs|test|perf|ci)/);
    const type = match ? match[1] : 'other';
    const key = type in typeCounters ? type : 'other';
    typeCounters[key] += 1;
    report.patterns.push({ type: key, subject: commit.subject, hash: commit.hash });
  }

  // Identify hot files (modified > 3 times)
  try {
    const { stdout } = await execFile(
      'git',
      ['log', `--since=${since}`, '--name-only', '--format=', '--no-merges'],
      { cwd, timeout: 30_000, encoding: 'utf-8' },
    );
    const fileCounts = {};
    for (const file of stdout.trim().split('\n').filter(Boolean)) {
      fileCounts[file] = (fileCounts[file] || 0) + 1;
    }
    report.hotFiles = Object.entries(fileCounts)
      .filter(([, count]) => count >= 3)
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count);
  } catch {
    report.hotFiles = [];
  }

  // Error trends: fix commits grouped by file
  const fixCommits = report.patterns.filter((p) => p.type === 'fix');
  if (fixCommits.length > 0) {
    try {
      for (const fix of fixCommits.slice(0, 20)) {
        const { stdout } = await execFile(
          'git',
          ['diff-tree', '--no-commit-id', '--name-only', '-r', fix.hash],
          { cwd, timeout: 10_000, encoding: 'utf-8' },
        );
        const files = stdout.trim().split('\n').filter(Boolean);
        report.errorTrends.push({ subject: fix.subject, files });
      }
    } catch {
      // Non-critical
    }
  }

  report.summary = { ...typeCounters, totalCommits: report.commits.length };

  // Collect provenance metadata and attach to report
  const firstCommit = report.commits.length > 0
    ? report.commits[report.commits.length - 1].hash
    : '';
  const lastCommit = report.commits.length > 0
    ? report.commits[0].hash
    : '';
  report.provenance = await collectProvenance({ cwd, firstCommit, lastCommit });

  return report;
}
