#!/usr/bin/env node
/**
 * CI: Validate runtime task evaluation thresholds.
 *
 * Usage:
 *   node scripts/ci/validate-runtime-evals.js
 *   node scripts/ci/validate-runtime-evals.js --check
 */

import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from './ci-utils.js';
import { formatRuntimeEvalComparisonMarkdown } from '../../lib/runtime/evaluator.js';

const THRESHOLDS = {
  minAverageScore: 0.9,
  maxFailedScenarios: 0,
  maxAverageRegression: 0.05,
};

function readJson(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function formatGitHubStepSummary(report, comparison, checks) {
  const lines = [
    '## Runtime Eval Gate',
    '',
    `Report generated: ${report.generatedAt}`,
    '',
    '| Check | Actual | Expected | Status |',
    '|---|---|---|---|',
  ];

  for (const check of checks) {
    lines.push(`| ${check.label} | ${check.actual} | ${check.expected} | ${check.passed ? 'PASS' : 'FAIL'} |`);
  }

  lines.push('');
  lines.push(formatRuntimeEvalComparisonMarkdown(comparison));
  lines.push('');
  return lines.join('\n');
}

function writeGitHubStepSummary(report, comparison, checks) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  appendFileSync(summaryPath, formatGitHubStepSummary(report, comparison, checks), 'utf-8');
}

function main() {
  const pluginRoot = getPluginRoot();
  const checkOnly = process.argv.includes('--check');
  const reportPath = path.join(pluginRoot, '_reports', 'runtime-task-suite.json');
  const comparisonPath = path.join(pluginRoot, '_reports', 'runtime-eval-comparison.json');

  if (!checkOnly) {
    console.log('Running runtime eval suite...\n');
    execSync('node scripts/evals/run-runtime-task-suite.js', {
      cwd: pluginRoot,
      stdio: 'inherit',
      timeout: 120_000,
    });
    console.log('');
  }

  let report;
  let comparison;

  if (checkOnly && (!existsSync(reportPath) || !existsSync(comparisonPath))) {
    console.warn('WARN: Runtime eval report(s) not found — skipping check (first run).');
    console.warn(`  report:     ${reportPath}`);
    console.warn(`  comparison: ${comparisonPath}`);
    console.log('\nNo prior runtime eval data. Run without --check to generate baseline.');
    return;
  }

  try {
    report = readJson(reportPath, 'runtime eval report');
    comparison = readJson(comparisonPath, 'runtime eval comparison report');
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }

  console.log('Runtime Eval Validation');
  console.log('=======================');

  let failures = 0;

  const checks = [
    {
      label: 'averageScore',
      actual: report.averageScore,
      expected: `>= ${THRESHOLDS.minAverageScore}`,
      passed: report.averageScore >= THRESHOLDS.minAverageScore,
    },
    {
      label: 'failedScenarios',
      actual: report.failed,
      expected: `<= ${THRESHOLDS.maxFailedScenarios}`,
      passed: report.failed <= THRESHOLDS.maxFailedScenarios,
    },
    {
      label: 'passedEqualsTotal',
      actual: `${report.passed}/${report.total}`,
      expected: 'all passed',
      passed: report.passed === report.total,
    },
  ];

  if (comparison.previous && comparison.delta.averageScore !== null) {
    checks.push({
      label: 'averageRegression',
      actual: comparison.delta.averageScore,
      expected: `>= -${THRESHOLDS.maxAverageRegression}`,
      passed: comparison.delta.averageScore >= -THRESHOLDS.maxAverageRegression,
    });
  }

  for (const check of checks) {
    const status = check.passed ? 'PASS' : 'FAIL';
    console.log(`  ${status}: ${check.label.padEnd(18)} actual=${check.actual} expected=${check.expected}`);
    if (!check.passed) {
      failures++;
    }
  }

  writeGitHubStepSummary(report, comparison, checks);

  console.log('');
  if (failures > 0) {
    console.error(`${failures} runtime eval threshold(s) failed.`);
    process.exit(1);
  }

  console.log('All runtime eval thresholds passed.');
}

main();
