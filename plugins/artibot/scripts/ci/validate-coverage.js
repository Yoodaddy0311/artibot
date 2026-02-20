#!/usr/bin/env node
/**
 * CI: Validate test coverage thresholds.
 * Runs vitest with coverage and verifies that all thresholds are met.
 * Reads the JSON summary report produced by vitest/v8 coverage.
 *
 * Usage:
 *   node scripts/ci/validate-coverage.js          # run tests + check
 *   node scripts/ci/validate-coverage.js --check   # check existing report only
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from './ci-utils.js';

const THRESHOLDS = {
  statements: 90,
  branches: 85,
  functions: 88,
  lines: 90,
};

function main() {
  const pluginRoot = getPluginRoot();
  const checkOnly = process.argv.includes('--check');
  const summaryPath = path.join(pluginRoot, 'coverage', 'coverage-summary.json');

  // Step 1: Run tests with coverage (unless --check flag is used)
  if (!checkOnly) {
    console.log('Running tests with coverage...\n');
    try {
      execSync('npx vitest run --coverage', {
        cwd: pluginRoot,
        stdio: 'inherit',
        timeout: 120_000,
      });
    } catch {
      console.error('\nFAIL: Test suite failed. Coverage validation aborted.');
      process.exit(1);
    }
    console.log('');
  }

  // Step 2: Read the JSON summary report
  if (!existsSync(summaryPath)) {
    console.error(
      'FAIL: coverage/coverage-summary.json not found.\n' +
      '      Run "npm run test:coverage" first, or remove the --check flag.',
    );
    process.exit(1);
  }

  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
  } catch (err) {
    console.error(`FAIL: Could not parse coverage-summary.json: ${err.message}`);
    process.exit(1);
  }

  const totals = summary.total;
  if (!totals) {
    console.error('FAIL: coverage-summary.json missing "total" entry.');
    process.exit(1);
  }

  // Step 3: Validate each threshold
  let failures = 0;

  console.log('Coverage Threshold Validation');
  console.log('=============================');

  for (const [metric, threshold] of Object.entries(THRESHOLDS)) {
    const actual = totals[metric]?.pct;

    if (actual == null) {
      console.error(`FAIL: ${metric} - metric not found in coverage report`);
      failures++;
      continue;
    }

    const passed = actual >= threshold;
    const status = passed ? 'PASS' : 'FAIL';
    const symbol = passed ? '+' : '-';
    const delta = (actual - threshold).toFixed(2);
    const sign = actual >= threshold ? '+' : '';

    console.log(
      `  ${status}: ${metric.padEnd(12)} ${actual.toFixed(2)}% / ${threshold}% (${sign}${delta}%) [${symbol}]`,
    );

    if (!passed) {
      failures++;
    }
  }

  console.log('');

  if (failures > 0) {
    console.error(
      `${failures} threshold(s) not met. ` +
      'Increase test coverage before merging.',
    );
    process.exit(1);
  }

  console.log('All coverage thresholds passed.');
}

main();
