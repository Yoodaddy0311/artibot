/**
 * Auto-Learning Pipeline Runner — Main Orchestrator.
 * Coordinates the 5-stage autonomous learning pipeline:
 *   1. Self-Scan — lint, test, coverage evaluation
 *   2. Pattern Extract — git log analysis for recurring patterns
 *   3. Knowledge Update — persist to memory, promote/demote patterns
 *   4. Skill Refinement — update skill triggers and references
 *   5. Auto-Commit — commit and push changes
 *
 * Stage implementations are in separate modules:
 *   - auto-learning-scanner.js    (Stage 1)
 *   - auto-learning-extractor.js  (Stage 2 + Provenance)
 *   - auto-learning-committer.js  (Stage 5)
 *   - Stages 3-4 remain inline (small, tightly coupled to orchestrator)
 *
 * Designed for unattended execution via `claude schedule` or CronCreate.
 * Zero runtime deps. ESM only.
 *
 * @module lib/learning/auto-learning-runner
 */

import path from 'node:path';
import { ensureDir, readJsonFile, writeJsonFile } from '../core/file.js';
import { ARTIBOT_DIR } from '../core/index.js';
import { getPluginRoot } from '../core/platform.js';

// Re-export all stage functions for backward compatibility
export { runSelfScan, execCapture, parseLintOutput, parseTestOutput } from './auto-learning-scanner.js';
export {
  runPatternExtract,
  collectProvenance,
  stripProvenancePII,
  hashShort,
} from './auto-learning-extractor.js';
export {
  runAutoCommit,
  checkBranchSafety,
  countChanges,
  matchGlob,
  isAutoCommitAllowed,
  getFilteredChanges,
  buildAutoCommitMessage,
  AUTO_COMMIT_ALLOWLIST,
  AUTO_COMMIT_DENYLIST,
} from './auto-learning-committer.js';

// Import for internal use by orchestrator
import { runSelfScan } from './auto-learning-scanner.js';
import { collectProvenance, runPatternExtract } from './auto-learning-extractor.js';
import { runAutoCommit } from './auto-learning-committer.js';
import { evaluateGroup, updateWeights } from './grpo-optimizer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEARNING_LOG_PATH = path.join(ARTIBOT_DIR, 'learning-log.json');
const PATTERNS_DIR = path.join(ARTIBOT_DIR, 'patterns');
const MAX_LOG_ENTRIES = 200;

const VALID_STAGES = [
  'self-scan',
  'pattern-extract',
  'knowledge-update',
  'skill-refinement',
  'grpo',
];

// NOTE: config.learning.schedule (nightlyLearner/driftCheck cron fields) is
// defined in artibot.config.json but has no runtime consumer. The original
// nightly-learner.js module was removed as dead code. The scheduled-learning
// skill (skills/scheduled-learning/SKILL.md) documents the intended design
// but is not yet implemented. These config fields should be considered
// planned-but-not-implemented until a CronCreate-based scheduler is built.

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
    const { getSummary } = await import('./drift-detector.js');
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
      report.injectionsApplied = result?.injected ?? 0;
    } catch {
      // Non-critical
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

  // Stage 4b: GRPO — group-relative policy optimization over extracted patterns.
  // Synthesizes candidate strategies from the day's patterns, evaluates them
  // relatively, and updates grpo-history.json. Safe no-op when <2 patterns.
  if (shouldRun('grpo')) {
    result.stages.grpo = await runGrpoStage(
      result.stages.patternExtract ?? null,
      result.stages.selfScan ?? null,
    );
    result.stagesRun.push('grpo');
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
 * Run the GRPO stage: convert extracted patterns into GRPO candidates,
 * evaluate them as a group, and persist updated strategy weights.
 * Safe no-op when fewer than 2 patterns exist (GRPO requires group comparison).
 *
 * @param {object|null} patternExtract - Result from runPatternExtract stage.
 * @param {object|null} selfScan - Result from runSelfScan stage (for lint/test signal).
 * @returns {Promise<object>} stage report
 */
/**
 * Build the scan signal used by every candidate (exitCode + error count).
 * @param {object|null} selfScan
 * @returns {{ exitCode: number, errors: number }}
 */
function buildScanSignal(selfScan) {
  const lintOk = (selfScan?.lintErrors ?? 0) === 0;
  const testOk = selfScan?.testsPassed === true;
  return {
    exitCode: lintOk && testOk ? 0 : 1,
    errors: selfScan?.lintErrors ?? 0,
  };
}

/**
 * Convert extracted commit patterns into GRPO candidate objects.
 * @param {object[]} patterns
 * @param {{ exitCode: number, errors: number }} signal
 * @returns {object[]}
 */
function patternsToCandidates(patterns, signal) {
  const ts = Date.now();
  return patterns.map((p, i) => ({
    id: `auto-learn-cand-${ts}-${i}`,
    strategy: (p?.type && typeof p.type === 'string') ? p.type : 'default',
    result: {
      exitCode: signal.exitCode,
      errors: signal.errors,
      duration: 1000,
      commandLength: typeof p?.subject === 'string' ? p.subject.length : 0,
      sideEffects: 0,
    },
  }));
}

/**
 * Summarize a GRPO group result into the stage report shape.
 * @param {object} groupResult
 * @param {number} candidateCount
 * @returns {object}
 */
function summarizeGrpoResult(groupResult, candidateCount) {
  const best = groupResult?.best ?? null;
  const spread = typeof groupResult?.spread === 'number' ? groupResult.spread : 0;
  return {
    candidateCount,
    bestStrategy: best?.strategy ?? null,
    bestScore: typeof best?.composite === 'number' ? Math.round(best.composite * 1000) / 1000 : null,
    spread: Math.round(spread * 1000) / 1000,
  };
}

export async function runGrpoStage(patternExtract, selfScan) {
  try {
    const patterns = Array.isArray(patternExtract?.patterns) ? patternExtract.patterns : [];
    if (patterns.length < 2) {
      return { skipped: true, reason: 'insufficient-patterns', minimumNeeded: 2, got: patterns.length };
    }
    const signal = buildScanSignal(selfScan);
    const candidates = patternsToCandidates(patterns, signal);
    const groupResult = evaluateGroup(candidates);
    await updateWeights(groupResult);
    return summarizeGrpoResult(groupResult, candidates.length);
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
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
