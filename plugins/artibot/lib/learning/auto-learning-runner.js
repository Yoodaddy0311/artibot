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

const VALID_STAGES = [
  'self-scan',
  'pattern-extract',
  'knowledge-update',
  'skill-refinement',
];

const PROTECTED_BRANCHES = ['main', 'master'];

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

  // Lint
  try {
    const { stdout } = await execFile('npx', ['eslint', '.', '--format', 'json'], {
      cwd,
      timeout: EXEC_TIMEOUT,
      encoding: 'utf-8',
    });
    const eslintResult = JSON.parse(stdout);
    const errorCount = eslintResult.reduce((sum, f) => sum + f.errorCount, 0);
    const warningCount = eslintResult.reduce((sum, f) => sum + f.warningCount, 0);
    report.lint = { errorCount, warningCount, passed: errorCount === 0 };
  } catch (err) {
    report.lint = { errorCount: -1, warningCount: -1, passed: false, error: err.message };
  }

  // Tests
  try {
    const { stdout } = await execFile('npx', ['vitest', 'run', '--reporter=json'], {
      cwd,
      timeout: EXEC_TIMEOUT,
      encoding: 'utf-8',
    });
    const testResult = JSON.parse(stdout);
    const passed = testResult.numPassedTests ?? 0;
    const failed = testResult.numFailedTests ?? 0;
    report.tests = { passed, failed, total: passed + failed, allPassed: failed === 0 };
  } catch (err) {
    report.tests = { passed: 0, failed: -1, total: -1, allPassed: false, error: err.message };
  }

  // Coverage (parse from vitest JSON output if available)
  try {
    const { stdout } = await execFile(
      'npx',
      ['vitest', 'run', '--coverage', '--reporter=json'],
      { cwd, timeout: EXEC_TIMEOUT, encoding: 'utf-8' },
    );
    const coverageResult = JSON.parse(stdout);
    const summary = coverageResult.coverageMap?.total ?? {};
    report.coverage = {
      statements: round(summary.statements?.pct ?? 0),
      branches: round(summary.branches?.pct ?? 0),
      functions: round(summary.functions?.pct ?? 0),
      lines: round(summary.lines?.pct ?? 0),
    };
  } catch {
    report.coverage = null;
  }

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

  // Count changes
  const changes = await countChanges({ cwd });
  report.changesCount = changes;

  if (changes === 0) {
    report.skipped = true;
    report.reason = 'no changes to commit';
    return report;
  }

  if (changes > config.maxChangesPerRun) {
    report.aborted = true;
    report.reason = `changes (${changes}) exceed maxChangesPerRun (${config.maxChangesPerRun})`;
    return report;
  }

  // Commit
  const dateStr = new Date().toISOString().slice(0, 10);
  const stages = pipelineResult.stagesRun?.join(', ') ?? 'all';
  const commitMsg = `chore(auto-learn): nightly pipeline — ${dateStr} [${stages}]`;

  try {
    await execFile('git', ['add', '-A'], { cwd, timeout: 30_000 });
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
