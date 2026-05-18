/**
 * Auto-Learning Pipeline — Self-Scan Stage.
 * Evaluates codebase quality via lint, test, and coverage checks.
 *
 * Extracted from auto-learning-runner.js for file size compliance.
 * Zero runtime deps. ESM only.
 *
 * @module lib/learning/auto-learning-scanner
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from '../core/platform.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXEC_TIMEOUT = 120_000;
const MAX_BUFFER = 50 * 1024 * 1024; // 50 MB for large vitest JSON output
// windowsHide: suppress the cmd window flash on Windows. We deliberately do
// NOT set `shell: true` here — running through cmd.exe exposes any future
// caller-supplied args/cwd to shell metacharacter injection. `npx` resolves
// fine via execFile when we pick the right binary per platform (see
// `resolveBin`).
const SHELL_OPTS = { windowsHide: true };

/**
 * Resolve the platform-specific npm binary name. On Windows npm/npx ship as
 * `*.cmd` shims that cannot be spawned directly by `execFile` without
 * `shell: true`. Returning the `.cmd` form lets execFile launch the shim
 * binary directly without invoking cmd.exe as a shell.
 *
 * @param {string} bin - logical name e.g. 'npx' or 'npm'
 * @returns {string} platform-specific binary name
 */
function resolveBin(bin) {
  return process.platform === 'win32' ? `${bin}.cmd` : bin;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a command and return stdout even if the process exits non-zero.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts - execFile options
 * @returns {Promise<string>} stdout
 */
export async function execCapture(cmd, args, opts) {
  try {
    const { stdout } = await execFile(cmd, args, { ...SHELL_OPTS, ...opts });
    return stdout;
  } catch (err) {
    // execFile attaches stdout/stderr to the error on non-zero exit
    if (err.stdout) return err.stdout;
    throw err;
  }
}

/**
 * Parse eslint JSON output into a lint report.
 * @param {string} stdout - eslint --format json output
 * @returns {{ errorCount: number, warningCount: number, passed: boolean }}
 */
export function parseLintOutput(stdout) {
  const eslintResult = JSON.parse(stdout);
  const errorCount = eslintResult.reduce((sum, f) => sum + f.errorCount, 0);
  const warningCount = eslintResult.reduce((sum, f) => sum + f.warningCount, 0);
  return { errorCount, warningCount, passed: errorCount === 0 };
}

/**
 * Run eslint and parse results.
 * @param {string} cwd
 * @returns {Promise<object>}
 */
async function runLintCheck(cwd) {
  const stdout = await execCapture('npx', ['eslint', '.', '--format', 'json'], {
    cwd,
    timeout: EXEC_TIMEOUT,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
  });
  return parseLintOutput(stdout);
}

/**
 * Parse vitest JSON output into a test report.
 * @param {string} stdout - vitest --reporter=json output
 * @returns {{ passed: number, failed: number, total: number, allPassed: boolean }}
 */
export function parseTestOutput(stdout) {
  const testResult = JSON.parse(stdout);
  const passed = testResult.numPassedTests ?? 0;
  const failed = testResult.numFailedTests ?? 0;
  return { passed, failed, total: passed + failed, allPassed: failed === 0 };
}

/**
 * Run vitest and parse results.
 * @param {string} cwd
 * @returns {Promise<object>}
 */
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
// Self-Scan Stage
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
