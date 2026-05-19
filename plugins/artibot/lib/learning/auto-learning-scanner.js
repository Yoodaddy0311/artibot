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
 * Resolve a locally-installed CLI's JS entry inside the plugin's
 * `node_modules/.bin`-equivalent path. We deliberately spawn it via
 * `process.execPath` (the running Node binary) rather than the platform
 * shim (`npx`, `npm.cmd`, `.bat`) so cmd.exe / sh never interprets args.
 *
 * @param {string} cwd - directory to resolve from (plugin root)
 * @param {string} pkg - npm package name (e.g. 'eslint', 'vitest')
 * @param {string} relBin - relative JS entry inside the package
 *   (e.g. 'bin/eslint.js', 'vitest.mjs')
 * @returns {string|null} absolute path to the JS entry, or null if missing
 */
function resolvePackageBin(cwd, pkg, relBin) {
  const candidate = path.join(cwd, 'node_modules', pkg, relBin);
  return existsSync(candidate) ? candidate : null;
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
  const eslintJs = resolvePackageBin(cwd, 'eslint', 'bin/eslint.js');
  if (!eslintJs) {
    return { errorCount: 0, warningCount: 0, passed: true, skipped: 'eslint not installed' };
  }
  const stdout = await execCapture(process.execPath, [eslintJs, '.', '--format', 'json'], {
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
  const vitestJs = resolvePackageBin(cwd, 'vitest', 'vitest.mjs');
  if (!vitestJs) {
    return { passed: 0, failed: 0, total: 0, allPassed: true, skipped: 'vitest not installed' };
  }
  const stdout = await execCapture(process.execPath, [vitestJs, 'run', '--reporter=json'], {
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
