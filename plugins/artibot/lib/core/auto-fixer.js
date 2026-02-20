/**
 * Ralph Engine - Auto-Fix Loop.
 * Runs eslint --fix -> vitest run -> result analysis -> convergence check.
 * Maximum 3 iterations by default. Reports results after each cycle.
 * @module lib/core/auto-fixer
 */

import { execSync } from 'node:child_process';

/**
 * Default options for the auto-fix loop.
 * @type {{ maxIterations: number, eslintFix: boolean, vitestRun: boolean, targetPath: string }}
 */
export const DEFAULT_OPTIONS = {
  maxIterations: 3,
  eslintFix: true,
  vitestRun: true,
  targetPath: '.',
};

/**
 * Parse eslint output to extract error and warning counts.
 * Looks for the summary line pattern: "N problems (X errors, Y warnings)".
 *
 * @param {string|null|undefined} output - Raw eslint stdout
 * @returns {{ errors: number, warnings: number, total: number, clean: boolean }}
 */
export function parseEslintOutput(output) {
  if (!output || typeof output !== 'string') {
    return { errors: 0, warnings: 0, total: 0, clean: true };
  }

  const summaryMatch = output.match(
    /(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/,
  );

  if (!summaryMatch) {
    return { errors: 0, warnings: 0, total: 0, clean: true };
  }

  const total = parseInt(summaryMatch[1], 10);
  const errors = parseInt(summaryMatch[2], 10);
  const warnings = parseInt(summaryMatch[3], 10);

  return { errors, warnings, total, clean: total === 0 };
}

/**
 * Parse vitest output to extract passed/failed/total counts.
 * Looks for the "Tests" summary line.
 *
 * @param {string|null|undefined} output - Raw vitest stdout
 * @returns {{ passed: number, failed: number, total: number, success: boolean }}
 */
export function parseVitestOutput(output) {
  if (!output || typeof output !== 'string') {
    return { passed: 0, failed: 0, total: 0, success: false };
  }

  // Match: "Tests  N failed | M passed (T)" or "Tests  M passed (T)"
  const testsLine = output.match(
    /Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed\s+\((\d+)\)/,
  );

  if (testsLine) {
    const failed = testsLine[1] ? parseInt(testsLine[1], 10) : 0;
    const passed = parseInt(testsLine[2], 10);
    const total = parseInt(testsLine[3], 10);
    return { passed, failed, total, success: failed === 0 };
  }

  // Match: "Tests  N failed (T)" (all failing, no passed count)
  const allFailLine = output.match(/Tests\s+(\d+)\s+failed\s+\((\d+)\)/);

  if (allFailLine) {
    const failed = parseInt(allFailLine[1], 10);
    const total = parseInt(allFailLine[2], 10);
    return { passed: 0, failed, total, success: false };
  }

  return { passed: 0, failed: 0, total: 0, success: false };
}

/**
 * Analyze iteration history to detect convergence, stall, or regression.
 *
 * @param {Array<{ eslint: { errors: number }, vitest: { failed: number } }>} history
 * @returns {{ converged: boolean, stalled: boolean, regressed: boolean, improving: boolean, reason: string }}
 */
export function checkConvergence(history) {
  const base = { converged: false, stalled: false, regressed: false, improving: false, reason: '' };

  if (!history || history.length === 0) {
    return { ...base, reason: 'No history' };
  }

  if (history.length === 1) {
    return { ...base, reason: 'Single iteration, cannot assess trend' };
  }

  const latest = history[history.length - 1];
  const previous = history[history.length - 2];

  const latestScore = latest.eslint.errors + latest.vitest.failed;
  const previousScore = previous.eslint.errors + previous.vitest.failed;

  // Converged: zero errors and zero failures
  if (latestScore === 0) {
    return { ...base, converged: true, reason: 'All errors and failures reached zero' };
  }

  // Regression: score increased
  if (latestScore > previousScore) {
    return { ...base, regressed: true, reason: 'Errors regressed from previous iteration' };
  }

  // Stalled: no change
  if (latestScore === previousScore) {
    return { ...base, stalled: true, reason: 'Errors stalled at same level' };
  }

  // Improving: score decreased but not zero
  return { ...base, improving: true, reason: 'Errors improving but not yet zero' };
}

/**
 * Run a single tool step (eslint or vitest) and return its stdout.
 * Handles the case where execSync throws (e.g., exit code 1) by
 * extracting stdout from the error object.
 *
 * @param {string} command - Shell command to execute
 * @param {string} cwd - Working directory
 * @returns {{ output: string, threw: boolean }}
 */
function runStep(command, cwd) {
  try {
    const buf = execSync(command, { cwd, encoding: 'buffer', stdio: 'pipe' });
    return { output: buf.toString('utf-8'), threw: false };
  } catch (err) {
    // eslint/vitest exit with code 1 on errors but still produce stdout
    if (err.stdout) {
      return { output: err.stdout.toString('utf-8'), threw: true };
    }
    throw err;
  }
}

/**
 * Main auto-fix loop. Runs eslint --fix then vitest, analyzes results,
 * checks convergence, and repeats up to maxIterations.
 *
 * @param {object} [options]
 * @param {string} [options.targetPath='.'] - Working directory / target path
 * @param {number} [options.maxIterations=3] - Maximum loop iterations
 * @param {boolean} [options.eslintFix=true] - Run eslint --fix step
 * @param {boolean} [options.vitestRun=true] - Run vitest step
 * @returns {{
 *   success: boolean,
 *   iterations: number,
 *   history: Array<{ eslint: object, vitest: object }>,
 *   finalStatus: { eslint: object, vitest: object },
 *   reason: string,
 *   error: string | null
 * }}
 */
export function autoFix(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { maxIterations, eslintFix, vitestRun, targetPath } = opts;

  const history = [];
  let lastEslint = { errors: 0, warnings: 0, total: 0, clean: true };
  let lastVitest = { passed: 0, failed: 0, total: 0, success: true };

  for (let i = 0; i < maxIterations; i++) {
    let eslintResult;
    let vitestResult;

    try {
      // Step 1: ESLint --fix
      if (eslintFix) {
        const { output } = runStep('npx eslint --fix .', targetPath);
        eslintResult = parseEslintOutput(output);
      } else {
        eslintResult = { errors: 0, warnings: 0, total: 0, clean: true };
      }

      // Step 2: Vitest run
      if (vitestRun) {
        const { output } = runStep('npx vitest run', targetPath);
        vitestResult = parseVitestOutput(output);
      } else {
        vitestResult = { passed: 0, failed: 0, total: 0, success: true };
      }
    } catch (err) {
      // Unexpected error (e.g., ENOENT - tool not found)
      return {
        success: false,
        iterations: i + 1,
        history,
        finalStatus: { eslint: lastEslint, vitest: lastVitest },
        reason: 'Unexpected error',
        error: err.message,
      };
    }

    lastEslint = eslintResult;
    lastVitest = vitestResult;
    history.push({ eslint: eslintResult, vitest: vitestResult });

    // Check convergence after at least 1 iteration
    if (history.length >= 2) {
      const convergence = checkConvergence(history);

      if (convergence.converged) {
        return {
          success: true,
          iterations: i + 1,
          history,
          finalStatus: { eslint: lastEslint, vitest: lastVitest },
          reason: convergence.reason,
          error: null,
        };
      }

      if (convergence.stalled) {
        return {
          success: false,
          iterations: i + 1,
          history,
          finalStatus: { eslint: lastEslint, vitest: lastVitest },
          reason: `Fix loop stalled: ${convergence.reason}`,
          error: null,
        };
      }

      if (convergence.regressed) {
        return {
          success: false,
          iterations: i + 1,
          history,
          finalStatus: { eslint: lastEslint, vitest: lastVitest },
          reason: `Fix loop regressed: ${convergence.reason}`,
          error: null,
        };
      }
    }

    // First iteration with clean state = success
    if (eslintResult.clean && vitestResult.success) {
      return {
        success: true,
        iterations: i + 1,
        history,
        finalStatus: { eslint: lastEslint, vitest: lastVitest },
        reason: 'All checks passed',
        error: null,
      };
    }
  }

  // Reached max iterations without convergence
  return {
    success: false,
    iterations: maxIterations,
    history,
    finalStatus: { eslint: lastEslint, vitest: lastVitest },
    reason: 'Max iterations reached without convergence',
    error: null,
  };
}

/**
 * Convenience wrapper around autoFix for a given target path.
 *
 * @param {string} targetPath - Directory to run the fix loop in
 * @returns {object} Same return shape as autoFix()
 */
export function runFixLoop(targetPath) {
  return autoFix({ targetPath });
}
