/**
 * Tests for Ralph Engine (Auto-Fix Loop).
 * TDD: Tests written first, implementation follows.
 *
 * Covers: autoFix(options), runFixLoop(targetPath), parseEslintOutput(),
 * parseVitestOutput(), and convergence detection.
 *
 * child_process.execSync is fully mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import {
  autoFix,
  runFixLoop,
  parseEslintOutput,
  parseVitestOutput,
  checkConvergence,
  DEFAULT_OPTIONS,
} from '../../lib/core/auto-fixer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ESLINT_CLEAN = '';

const ESLINT_WITH_ERRORS = [
  '/project/lib/core/config.js',
  '  10:5  error  Unexpected console statement  no-console',
  '  25:1  warning  Missing JSDoc  jsdoc/require-jsdoc',
  '',
  '/project/lib/core/io.js',
  '  3:10  error  \'fs\' is defined but never used  no-unused-vars',
  '',
  '3 problems (2 errors, 1 warning)',
].join('\n');

const ESLINT_ONLY_WARNINGS = [
  '/project/lib/core/debug.js',
  '  5:1  warning  Unexpected any  @typescript-eslint/no-explicit-any',
  '',
  '1 problem (0 errors, 1 warning)',
].join('\n');

const VITEST_PASS = [
  'Test Files  5 passed (5)',
  'Tests  42 passed (42)',
  'Start at 10:00:00',
  'Duration  3.21s',
].join('\n');

const VITEST_FAIL = [
  'FAIL tests/core/config.test.js > Config > loads default',
  'AssertionError: expected null to be defined',
  '',
  'Test Files  1 failed | 4 passed (5)',
  'Tests  1 failed | 41 passed (42)',
  'Start at 10:00:00',
  'Duration  4.53s',
].join('\n');

const VITEST_ALL_FAIL = [
  'FAIL tests/core/a.test.js',
  'FAIL tests/core/b.test.js',
  '',
  'Test Files  2 failed (2)',
  'Tests  10 failed (10)',
  'Start at 10:00:00',
  'Duration  2.00s',
].join('\n');

// ---------------------------------------------------------------------------
// parseEslintOutput
// ---------------------------------------------------------------------------

describe('parseEslintOutput()', () => {
  it('returns zero counts for clean output', () => {
    const result = parseEslintOutput(ESLINT_CLEAN);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
    expect(result.total).toBe(0);
    expect(result.clean).toBe(true);
  });

  it('parses error and warning counts from summary line', () => {
    const result = parseEslintOutput(ESLINT_WITH_ERRORS);
    expect(result.errors).toBe(2);
    expect(result.warnings).toBe(1);
    expect(result.total).toBe(3);
    expect(result.clean).toBe(false);
  });

  it('parses warnings-only output', () => {
    const result = parseEslintOutput(ESLINT_ONLY_WARNINGS);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(1);
    expect(result.total).toBe(1);
    expect(result.clean).toBe(false);
  });

  it('handles null/undefined input gracefully', () => {
    expect(parseEslintOutput(null).clean).toBe(true);
    expect(parseEslintOutput(undefined).clean).toBe(true);
  });

  it('handles output with no summary line', () => {
    const result = parseEslintOutput('Some random text\nwithout summary');
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
    expect(result.clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseVitestOutput
// ---------------------------------------------------------------------------

describe('parseVitestOutput()', () => {
  it('parses all-passing output', () => {
    const result = parseVitestOutput(VITEST_PASS);
    expect(result.passed).toBe(42);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(42);
    expect(result.success).toBe(true);
  });

  it('parses output with failures', () => {
    const result = parseVitestOutput(VITEST_FAIL);
    expect(result.passed).toBe(41);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(42);
    expect(result.success).toBe(false);
  });

  it('parses all-failing output', () => {
    const result = parseVitestOutput(VITEST_ALL_FAIL);
    expect(result.failed).toBe(10);
    expect(result.passed).toBe(0);
    expect(result.total).toBe(10);
    expect(result.success).toBe(false);
  });

  it('handles null/undefined input gracefully', () => {
    const result = parseVitestOutput(null);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.success).toBe(false);
  });

  it('handles output with no test summary line', () => {
    const result = parseVitestOutput('Some random output');
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkConvergence
// ---------------------------------------------------------------------------

describe('checkConvergence()', () => {
  it('detects convergence when errors are zero', () => {
    const history = [
      { eslint: { errors: 5 }, vitest: { failed: 2 } },
      { eslint: { errors: 2 }, vitest: { failed: 1 } },
      { eslint: { errors: 0 }, vitest: { failed: 0 } },
    ];
    const result = checkConvergence(history);
    expect(result.converged).toBe(true);
    expect(result.reason).toContain('zero');
  });

  it('detects stalled convergence when errors stop decreasing', () => {
    const history = [
      { eslint: { errors: 5 }, vitest: { failed: 2 } },
      { eslint: { errors: 5 }, vitest: { failed: 2 } },
    ];
    const result = checkConvergence(history);
    expect(result.converged).toBe(false);
    expect(result.stalled).toBe(true);
  });

  it('detects regression when errors increase', () => {
    const history = [
      { eslint: { errors: 3 }, vitest: { failed: 1 } },
      { eslint: { errors: 5 }, vitest: { failed: 3 } },
    ];
    const result = checkConvergence(history);
    expect(result.converged).toBe(false);
    expect(result.regressed).toBe(true);
  });

  it('returns not converged for single iteration', () => {
    const history = [
      { eslint: { errors: 5 }, vitest: { failed: 2 } },
    ];
    const result = checkConvergence(history);
    expect(result.converged).toBe(false);
  });

  it('returns not converged for empty history', () => {
    const result = checkConvergence([]);
    expect(result.converged).toBe(false);
  });

  it('detects improving trend (not yet converged)', () => {
    const history = [
      { eslint: { errors: 10 }, vitest: { failed: 5 } },
      { eslint: { errors: 5 }, vitest: { failed: 2 } },
    ];
    const result = checkConvergence(history);
    expect(result.converged).toBe(false);
    expect(result.stalled).toBe(false);
    expect(result.regressed).toBe(false);
    expect(result.improving).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_OPTIONS
// ---------------------------------------------------------------------------

describe('DEFAULT_OPTIONS', () => {
  it('has maxIterations set to 3', () => {
    expect(DEFAULT_OPTIONS.maxIterations).toBe(3);
  });

  it('has eslintFix enabled', () => {
    expect(DEFAULT_OPTIONS.eslintFix).toBe(true);
  });

  it('has vitestRun enabled', () => {
    expect(DEFAULT_OPTIONS.vitestRun).toBe(true);
  });

  it('has default targetPath as "."', () => {
    expect(DEFAULT_OPTIONS.targetPath).toBe('.');
  });
});

// ---------------------------------------------------------------------------
// autoFix
// ---------------------------------------------------------------------------

describe('autoFix()', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it('runs eslint --fix then vitest and reports success when both pass', () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN))   // eslint --fix
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));    // vitest run

    const result = autoFix({ targetPath: '/project' });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.finalStatus.eslint.clean).toBe(true);
    expect(result.finalStatus.vitest.success).toBe(true);
  });

  it('retries up to maxIterations when eslint errors persist', () => {
    vi.mocked(execSync)
      // Iteration 1: eslint has errors, vitest passes
      .mockReturnValueOnce(Buffer.from(ESLINT_WITH_ERRORS))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS))
      // Iteration 2: same errors (stalled)
      .mockReturnValueOnce(Buffer.from(ESLINT_WITH_ERRORS))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    const result = autoFix({ targetPath: '/project', maxIterations: 2 });

    expect(result.success).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.reason).toContain('stalled');
  });

  it('stops early on convergence (errors reach zero)', () => {
    vi.mocked(execSync)
      // Iteration 1: has errors
      .mockReturnValueOnce(Buffer.from(ESLINT_WITH_ERRORS))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS))
      // Iteration 2: clean
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    const result = autoFix({ targetPath: '/project', maxIterations: 3 });

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
  });

  it('stops early on regression', () => {
    const moreErrors = [
      '/project/lib/core/config.js',
      '  10:5  error  Unexpected console statement  no-console',
      '  25:1  error  Missing JSDoc  jsdoc/require-jsdoc',
      '  30:1  error  Foo  bar',
      '  40:1  error  Baz  qux',
      '',
      '4 problems (4 errors, 0 warnings)',
    ].join('\n');

    vi.mocked(execSync)
      // Iteration 1: 2 errors
      .mockReturnValueOnce(Buffer.from(ESLINT_WITH_ERRORS))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS))
      // Iteration 2: 4 errors (regression)
      .mockReturnValueOnce(Buffer.from(moreErrors))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    const result = autoFix({ targetPath: '/project', maxIterations: 3 });

    expect(result.success).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.reason).toContain('regress');
  });

  it('uses default options when none provided', () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    const result = autoFix();

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
  });

  it('handles eslint command throwing (exit code 1)', () => {
    const error = new Error('eslint failed');
    error.stdout = Buffer.from(ESLINT_WITH_ERRORS);
    error.status = 1;

    vi.mocked(execSync)
      .mockImplementationOnce(() => { throw error; })
      .mockReturnValueOnce(Buffer.from(VITEST_PASS))
      // Iteration 2: same
      .mockImplementationOnce(() => { throw error; })
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    const result = autoFix({ targetPath: '/project', maxIterations: 2 });

    // Should still parse errors from stdout and continue the loop
    expect(result.iterations).toBe(2);
    expect(result.history).toHaveLength(2);
    expect(result.history[0].eslint.errors).toBe(2);
  });

  it('handles vitest command throwing (test failures)', () => {
    const error = new Error('vitest failed');
    error.stdout = Buffer.from(VITEST_FAIL);
    error.status = 1;

    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN))
      .mockImplementationOnce(() => { throw error; })
      // Iteration 2
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN))
      .mockImplementationOnce(() => { throw error; });

    const result = autoFix({ targetPath: '/project', maxIterations: 2 });

    expect(result.success).toBe(false);
    expect(result.history[0].vitest.failed).toBe(1);
  });

  it('handles unexpected exception from execSync', () => {
    vi.mocked(execSync)
      .mockImplementationOnce(() => { throw new Error('ENOENT: eslint not found'); });

    const result = autoFix({ targetPath: '/project', maxIterations: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('skips eslint when eslintFix is false', () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    const result = autoFix({ targetPath: '/project', eslintFix: false });

    expect(result.success).toBe(true);
    expect(result.finalStatus.eslint.clean).toBe(true);
    // Only vitest was called (1 call, not 2)
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('skips vitest when vitestRun is false', () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN));

    const result = autoFix({ targetPath: '/project', vitestRun: false });

    expect(result.success).toBe(true);
    expect(result.finalStatus.vitest.success).toBe(true);
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('includes history of all iterations in result', () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(ESLINT_WITH_ERRORS))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS))
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    const result = autoFix({ targetPath: '/project', maxIterations: 3 });

    expect(result.history).toHaveLength(2);
    expect(result.history[0].eslint.errors).toBe(2);
    expect(result.history[1].eslint.errors).toBe(0);
  });

  it('passes correct cwd to execSync calls', () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    autoFix({ targetPath: '/my/project' });

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('eslint'),
      expect.objectContaining({ cwd: '/my/project' }),
    );
  });
});

// ---------------------------------------------------------------------------
// runFixLoop
// ---------------------------------------------------------------------------

describe('runFixLoop()', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it('is a convenience wrapper that calls autoFix with targetPath', () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    const result = runFixLoop('/project/lib');

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);
  });

  it('uses default maxIterations of 3', () => {
    // All 3 iterations with persistent errors
    for (let i = 0; i < 3; i++) {
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from(ESLINT_WITH_ERRORS))
        .mockReturnValueOnce(Buffer.from(VITEST_PASS));
    }

    const result = runFixLoop('/project');

    // Should run up to 3 iterations (or stop on stall after 2)
    expect(result.iterations).toBeGreaterThanOrEqual(2);
    expect(result.iterations).toBeLessThanOrEqual(3);
  });

  it('returns structured report with all expected fields', () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(ESLINT_CLEAN))
      .mockReturnValueOnce(Buffer.from(VITEST_PASS));

    const result = runFixLoop('/project');

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('iterations');
    expect(result).toHaveProperty('history');
    expect(result).toHaveProperty('finalStatus');
    expect(result.finalStatus).toHaveProperty('eslint');
    expect(result.finalStatus).toHaveProperty('vitest');
  });
});
