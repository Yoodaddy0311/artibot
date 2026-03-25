/**
 * Auto-Learning Pipeline Runner.
 * Executes the 5-stage autonomous learning pipeline:
 *   1. Self-Scan — lint, test, coverage evaluation
 *   2. Pattern Extract — git log analysis for recurring patterns
 *   3. Knowledge Update — persist to memory, promote/demote patterns
 *   4. Skill Refinement — update skill triggers and references
 *   5. Auto-Commit — commit and push changes
 *
 * Designed for unattended execution via `claude schedule` or CronCreate.
 * Zero runtime deps. ESM only.
 *
 * @module lib/learning/auto-learning-runner
 */

import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readJsonFile, writeJsonFile, ensureDir } from '../core/file.js';
import { ARTIBOT_DIR, round } from '../core/index.js';
import { getPluginRoot } from '../core/platform.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEARNING_LOG_PATH = path.join(ARTIBOT_DIR, 'learning-log.json');
const PATTERNS_DIR = path.join(ARTIBOT_DIR, 'patterns');
const MAX_LOG_ENTRIES = 200;
const EXEC_TIMEOUT = 120_000;
const MAX_BUFFER = 50 * 1024 * 1024; // 50 MB for large vitest JSON output
const SHELL_OPTS = { shell: true }; // Required on Windows for npx resolution (NOT for git)

const VALID_STAGES = [
  'self-scan',
  'pattern-extract',
  'knowledge-update',
  'skill-refinement',
];

const PROTECTED_BRANCHES = ['main', 'master'];

/**
 * Files/directories allowed for auto-commit (glob patterns).
 * Only learning data and derived artifacts — never source code.
 */
const AUTO_COMMIT_ALLOWLIST = Object.freeze([
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
const AUTO_COMMIT_DENYLIST = Object.freeze([
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

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  schedule: '0 3 * * *',
  pipeline: [...VALID_STAGES],
  autoCommit: true,
  autoPush: true,
  maxChangesPerRun: 10,
  dryRun: false,
});

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Load autoLearning config from artibot.config.json.
 * Falls back to defaults for missing fields.
 * @returns {Promise<object>}
 */
export async function loadAutoLearningConfig() {
  const pluginRoot = getPluginRoot();
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  const full = await readJsonFile(configPath);
  const raw = full?.autoLearning ?? {};
  return { ...DEFAULT_CONFIG, ...raw };
}

/**
 * Validate pipeline config.
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConfig(config) {
  const errors = [];
  if (typeof config.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }
  if (typeof config.maxChangesPerRun !== 'number' || config.maxChangesPerRun < 1) {
    errors.push('maxChangesPerRun must be a positive number');
  }
  if (!Array.isArray(config.pipeline)) {
    errors.push('pipeline must be an array');
  } else {
    for (const stage of config.pipeline) {
      if (!VALID_STAGES.includes(stage)) {
        errors.push(`unknown pipeline stage: ${stage}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Provenance Tracking
// ---------------------------------------------------------------------------

/**
 * Hash a string with SHA-256 and return the first 8 hex chars.
 * Used for PII protection (email, hostname).
 * @param {string} value
 * @returns {string}
 */
function hashShort(value) {
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
// Stage 1: Self-Scan — helpers
// ---------------------------------------------------------------------------

/**
 * Run a command and return stdout even if the process exits non-zero.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts - execFile options
 * @returns {Promise<string>} stdout
 */
async function execCapture(cmd, args, opts) {
  try {
    const { stdout } = await execFile(cmd, args, { ...SHELL_OPTS, ...opts });
    return stdout;
  } catch (err) {
    // execFile attaches stdout/stderr to the error on non-zero exit
    if (err.stdout) return err.stdout;
    throw err;
  }
}

function parseLintOutput(stdout) {
  const eslintResult = JSON.parse(stdout);
  const errorCount = eslintResult.reduce((sum, f) => sum + f.errorCount, 0);
  const warningCount = eslintResult.reduce((sum, f) => sum + f.warningCount, 0);
  return { errorCount, warningCount, passed: errorCount === 0 };
}

async function runLintCheck(cwd) {
  const stdout = await execCapture('npx', ['eslint', '.', '--format', 'json'], {
    cwd,
    timeout: EXEC_TIMEOUT,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
  });
  return parseLintOutput(stdout);
}

function parseTestOutput(stdout) {
  const testResult = JSON.parse(stdout);
  const passed = testResult.numPassedTests ?? 0;
  const failed = testResult.numFailedTests ?? 0;
  return { passed, failed, total: passed + failed, allPassed: failed === 0 };
}

async function runTestCheck(cwd) {
  const stdout = await execCapture('npx', ['vitest', 'run', '--reporter=json'], {
    cwd,
    timeout: EXEC_TIMEOUT,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
  });
  return parseTestOutput(stdout);
}

// ---------------------------------------------------------------------------
// Stage 1: Self-Scan
// ---------------------------------------------------------------------------

/**
 * Run self-scan: lint, test, coverage.
 * @param {object} options
 * @param {string} [options.cwd] - Working directory
 * @returns {Promise<object>} ScanReport
 */
export async function runSelfScan(options = {}) {
  const cwd = options.cwd || getPluginRoot();
  const report = {
    stage: 'self-scan',
    timestamp: new Date().toISOString(),
    lint: null,
    tests: null,
    coverage: null,
  };

  // Lint — eslint exits non-zero when errors found, so parse err.stdout too
  try {
    report.lint = await runLintCheck(cwd);
  } catch {
    report.lint = { errorCount: -1, warningCount: -1, passed: false, error: 'lint check failed' };
  }

  // Tests — vitest exits non-zero on test failures, so parse err.stdout too
  try {
    report.tests = await runTestCheck(cwd);
  } catch {
    report.tests = { passed: 0, failed: -1, total: -1, allPassed: false, error: 'test check failed' };
  }

  // Coverage — skip separate run, rely on test results
  report.coverage = null;

  return report;
}

// ---------------------------------------------------------------------------
// Stage 2: Pattern Extract
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

// ---------------------------------------------------------------------------
// Stage 3: Knowledge Update
// ---------------------------------------------------------------------------

/**
 * Update knowledge stores with pipeline results.
 * @param {object} scanReport - From runSelfScan
 * @param {object} patternReport - From runPatternExtract
 * @param {object} options
 * @param {boolean} [options.dryRun] - Skip writes
 * @returns {Promise<object>} KnowledgeReport
 */
export async function runKnowledgeUpdate(scanReport, patternReport, options = {}) {
  const report = {
    stage: 'knowledge-update',
    timestamp: new Date().toISOString(),
    patternsSaved: 0,
    promoted: 0,
    demoted: 0,
    driftChecked: false,
  };

  if (options.dryRun) {
    report.dryRun = true;
    return report;
  }

  // Save patterns to patterns directory
  await ensureDir(PATTERNS_DIR);
  const dateKey = new Date().toISOString().slice(0, 10);
  const patternFilePath = path.join(PATTERNS_DIR, `auto-learn-${dateKey}.json`);

  const patternData = {
    generatedAt: report.timestamp,
    provenance: patternReport?.provenance ?? null,
    scan: {
      lintErrors: scanReport?.lint?.errorCount ?? -1,
      testsPassed: scanReport?.tests?.allPassed ?? false,
      coverage: scanReport?.coverage ?? null,
    },
    patterns: patternReport?.patterns ?? [],
    hotFiles: patternReport?.hotFiles ?? [],
    errorTrends: patternReport?.errorTrends ?? [],
  };

  await writeJsonFile(patternFilePath, patternData);
  report.patternsSaved = (patternReport?.patterns?.length ?? 0);

  // Run knowledge transfer (promote/demote)
  try {
    const { hotSwap } = await import('./knowledge-demotion.js');
    const swapResult = await hotSwap();
    report.promoted = swapResult?.promoted?.length ?? 0;
    report.demoted = swapResult?.demoted?.length ?? 0;
  } catch {
    // Non-critical
  }

  // Drift detection
  try {
    const { checkDrift, getSummary } = await import('./drift-detector.js');
    const summary = getSummary();
    report.driftChecked = true;
    report.driftSummary = summary;
  } catch {
    // Non-critical
  }

  return report;
}

// ---------------------------------------------------------------------------
// Stage 4: Skill Refinement
// ---------------------------------------------------------------------------

/**
 * Refine skill triggers and references based on learned patterns.
 * @param {object} patternReport - From runPatternExtract
 * @param {object} options
 * @param {boolean} [options.dryRun] - Skip writes
 * @returns {Promise<object>} RefinementReport
 */
export async function runSkillRefinement(patternReport, options = {}) {
  const report = {
    stage: 'skill-refinement',
    timestamp: new Date().toISOString(),
    skillsAnalyzed: 0,
    suggestionsGenerated: 0,
    injectionsApplied: 0,
  };

  if (options.dryRun) {
    report.dryRun = true;
    return report;
  }

  // Collect tool usage stats for skill analysis
  try {
    const { getToolStats } = await import('./tool-learner.js');
    const stats = getToolStats();
    report.skillsAnalyzed = Object.keys(stats).length;
  } catch {
    // Non-critical
  }

  // Generate improvement suggestions from error trends
  const errorFiles = patternReport?.errorTrends ?? [];
  const suggestions = [];

  for (const trend of errorFiles) {
    if (trend.files?.length > 0) {
      suggestions.push({
        type: 'error-pattern',
        subject: trend.subject,
        files: trend.files,
        recommendation: `Recurring fix pattern detected. Consider adding automated checks for: ${trend.subject}`,
      });
    }
  }

  report.suggestionsGenerated = suggestions.length;

  // Inject rules into relevant skills if meaningful patterns found
  if (suggestions.length > 0) {
    try {
      const { injectRules } = await import('./skill-injector.js');
      const rules = suggestions.slice(0, 5).map((s) => ({
        type: 'auto-learned',
        content: s.recommendation,
        lang: 'en',
        confidence: 0.7,
        rawMatch: s.subject,
      }));

      const result = await injectRules(rules, 'coding-standards');
      report.injectionsApplied = result?.injectedCount ?? 0;
    } catch {
      // Non-critical
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Stage 5: Auto-Commit — guardrails
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
  // Normalize separators
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const patParts = pattern.replace(/\\/g, '/').split('/');

  return _matchParts(parts, 0, patParts, 0);
}

function _matchParts(parts, pi, pats, qi) {
  if (qi === pats.length) return pi === parts.length;
  if (pi === parts.length) {
    // Remaining patterns must all be **
    for (let i = qi; i < pats.length; i++) {
      if (pats[i] !== '**') return false;
    }
    return true;
  }

  const pat = pats[qi];

  if (pat === '**') {
    // ** matches zero or more segments
    for (let skip = 0; skip <= parts.length - pi; skip++) {
      if (_matchParts(parts, pi + skip, pats, qi + 1)) return true;
    }
    return false;
  }

  if (pat === '*') {
    // * matches exactly one segment (any content)
    return _matchParts(parts, pi + 1, pats, qi + 1);
  }

  // Literal match
  if (parts[pi] === pat) {
    return _matchParts(parts, pi + 1, pats, qi + 1);
  }

  return false;
}

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
 * @returns {Promise<{ allowed: string[], blocked: string[], total: number }>}
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

/**
 * Build auto-commit message with [AUTOMATED] tag and metadata.
 *
 * @param {object} pipelineResult
 * @param {number} allowedCount
 * @param {number} blockedCount
 * @param {object} [provenance] - From collectProvenance()
 * @returns {string}
 */
function buildAutoCommitMessage(pipelineResult, allowedCount, blockedCount, provenance) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const stages = pipelineResult.stagesRun?.join(', ') ?? 'all';
  const machineHash = provenance?.machineHash || hashShort(os.hostname());
  const version = provenance?.pipelineVersion || '1.14.0';
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
// Stage 5: Auto-Commit
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
  report.blockedFiles = blocked.slice(0, 20); // Limit for log size

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

// ---------------------------------------------------------------------------
// Pipeline Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full auto-learning pipeline.
 * @param {object} [overrideConfig] - Override config values
 * @returns {Promise<object>} Full pipeline result
 */
export async function runAutoLearningPipeline(overrideConfig = {}) {
  const config = { ...(await loadAutoLearningConfig()), ...overrideConfig };

  const validation = validateConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      errors: validation.errors,
      timestamp: new Date().toISOString(),
    };
  }

  const result = {
    timestamp: new Date().toISOString(),
    config: {
      pipeline: config.pipeline,
      dryRun: config.dryRun,
      maxChangesPerRun: config.maxChangesPerRun,
    },
    stagesRun: [],
    stages: {},
    success: true,
  };

  const shouldRun = (stage) => config.pipeline.includes(stage);

  // Stage 1: Self-Scan
  if (shouldRun('self-scan')) {
    result.stages.selfScan = await runSelfScan();
    result.stagesRun.push('self-scan');
  }

  // Stage 2: Pattern Extract
  if (shouldRun('pattern-extract')) {
    result.stages.patternExtract = await runPatternExtract();
    result.stagesRun.push('pattern-extract');
  }

  // Stage 3: Knowledge Update
  if (shouldRun('knowledge-update')) {
    result.stages.knowledgeUpdate = await runKnowledgeUpdate(
      result.stages.selfScan ?? null,
      result.stages.patternExtract ?? null,
      { dryRun: config.dryRun },
    );
    result.stagesRun.push('knowledge-update');
  }

  // Stage 4: Skill Refinement
  if (shouldRun('skill-refinement')) {
    result.stages.skillRefinement = await runSkillRefinement(
      result.stages.patternExtract ?? null,
      { dryRun: config.dryRun },
    );
    result.stagesRun.push('skill-refinement');
  }

  // Attach provenance from pattern-extract (or collect fresh)
  result.provenance = result.stages.patternExtract?.provenance
    ?? await collectProvenance();

  // Stage 5: Auto-Commit
  const commitReport = await runAutoCommit(config, result);
  result.stages.autoCommit = commitReport;
  if (commitReport.committed || commitReport.dryRun || commitReport.skipped) {
    result.stagesRun.push('auto-commit');
  }

  // Write pipeline run to learning log
  await appendPipelineLog(result);

  return result;
}

/**
 * Append pipeline run result to learning-log.json.
 * @param {object} result
 * @returns {Promise<void>}
 */
async function appendPipelineLog(result) {
  try {
    const existing = (await readJsonFile(LEARNING_LOG_PATH)) ?? { entries: [] };
    const entries = Array.isArray(existing.entries) ? existing.entries : [];

    entries.push({
      type: 'auto-learning-pipeline',
      timestamp: result.timestamp,
      provenance: result.provenance ?? null,
      stagesRun: result.stagesRun,
      success: result.success,
      summary: {
        lintPassed: result.stages.selfScan?.lint?.passed ?? null,
        testsPassed: result.stages.selfScan?.tests?.allPassed ?? null,
        patternsFound: result.stages.patternExtract?.patterns?.length ?? 0,
        hotFiles: result.stages.patternExtract?.hotFiles?.length ?? 0,
        promoted: result.stages.knowledgeUpdate?.promoted ?? 0,
        demoted: result.stages.knowledgeUpdate?.demoted ?? 0,
        committed: result.stages.autoCommit?.committed ?? false,
      },
    });

    // Trim to max entries
    while (entries.length > MAX_LOG_ENTRIES) {
      entries.shift();
    }

    await writeJsonFile(LEARNING_LOG_PATH, { ...existing, entries });
  } catch {
    // Non-critical: logging failure should not break the pipeline
  }
}
