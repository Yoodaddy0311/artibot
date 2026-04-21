/**
 * Rollback Guard — AGO Self-Control Wave 1 Module 2.
 *
 * Snapshots the current git HEAD before a self-control action, runs the
 * project's test + lint validation suite, and can reverse the HEAD commit
 * if regressions are detected. The `rollback` path only accepts a snapshot
 * object that was created in the same process (session id check) — external
 * or stale snapshots are rejected.
 *
 * Safety invariants:
 *   - Never calls `git push` or any remote-mutating command.
 *   - Only resets HEAD (single commit); does not touch older history.
 *   - All git I/O goes through `spawn`, never through shell interpolation.
 *
 * @module lib/learning/rollback-guard
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Process-local session id — rollback only accepts snapshots from same run.
// ---------------------------------------------------------------------------

const SESSION_ID = randomUUID();

// ---------------------------------------------------------------------------
// Spawn helper (promise-based, argv only — no shell)
// ---------------------------------------------------------------------------

/**
 * Run a command with argv (no shell). Resolves with `{code, stdout, stderr}`.
 * Rejects only on spawn errors, not on non-zero exit codes.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Capture the current HEAD sha so the caller can later rollback to it.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @returns {Promise<{sha: string, timestamp: string, sessionId: string}>}
 */
export async function snapshot(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const { code, stdout, stderr } = await run('git', ['rev-parse', 'HEAD'], { cwd });
  if (code !== 0) {
    throw new Error(`snapshot failed: git rev-parse exited ${code} (${stderr.trim()})`);
  }
  const sha = stdout.trim();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`snapshot failed: invalid sha "${sha}"`);
  }
  return {
    sha,
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
}

// ---------------------------------------------------------------------------
// Validation suite (tests + lint)
// ---------------------------------------------------------------------------

/**
 * Execute the validation suite and return a structured result. Either test
 * or lint failure marks `passed` as false.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.runTests=true]
 * @param {boolean} [opts.runLint=true]
 * @returns {Promise<{passed: boolean, tests: {passed: boolean, code: number}, lint: {passed: boolean, code: number}}>}
 */
export async function runValidation(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const runTests = opts.runTests !== false;
  const runLint = opts.runLint !== false;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  let tests = { passed: true, code: 0 };
  let lint = { passed: true, code: 0 };

  if (runTests) {
    const res = await run(npm, ['test', '--silent'], { cwd });
    tests = { passed: res.code === 0, code: res.code };
  }
  if (runLint) {
    const res = await run(npm, ['run', 'lint', '--silent'], { cwd });
    lint = { passed: res.code === 0, code: res.code };
  }

  return { passed: tests.passed && lint.passed, tests, lint };
}

/**
 * Compare the current validation result against a baseline. A "regression"
 * is any component that was passing in baseline and now fails.
 *
 * @param {object} baseline - prior `runValidation` result
 * @param {object} [opts]
 * @returns {Promise<{passed: boolean, regressions: string[], current: object, baseline: object}>}
 */
export async function validateAgainstBaseline(baseline, opts = {}) {
  const current = await runValidation(opts);
  const regressions = [];
  if (baseline?.tests?.passed && !current.tests.passed) regressions.push('tests');
  if (baseline?.lint?.passed && !current.lint.passed) regressions.push('lint');
  return {
    passed: regressions.length === 0,
    regressions,
    current,
    baseline: baseline || null,
  };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Revert HEAD to the snapshot sha via `git reset --hard <sha>`.
 *
 * SAFETY:
 *   - Only accepts snapshots whose `sessionId` matches this process.
 *   - Only resets HEAD; never touches remotes.
 *   - Never invokes `git push` under any circumstance.
 *
 * @param {{sha: string, sessionId: string}} snapshotData
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @returns {Promise<{reverted: boolean, sha: string, reason?: string}>}
 */
export async function rollback(snapshotData, opts = {}) {
  if (!snapshotData || typeof snapshotData !== 'object') {
    return { reverted: false, sha: '', reason: 'invalid snapshot' };
  }
  if (snapshotData.sessionId !== SESSION_ID) {
    return { reverted: false, sha: snapshotData.sha || '', reason: 'foreign session' };
  }
  if (!/^[0-9a-f]{7,40}$/.test(snapshotData.sha || '')) {
    return { reverted: false, sha: snapshotData.sha || '', reason: 'invalid sha' };
  }

  const cwd = opts.cwd || process.cwd();

  // Verify the snapshot sha still exists in the repo before attempting reset.
  const check = await run('git', ['cat-file', '-e', snapshotData.sha], { cwd });
  if (check.code !== 0) {
    return { reverted: false, sha: snapshotData.sha, reason: 'sha not found in repo' };
  }

  const reset = await run('git', ['reset', '--hard', snapshotData.sha], { cwd });
  if (reset.code !== 0) {
    return {
      reverted: false,
      sha: snapshotData.sha,
      reason: `git reset exited ${reset.code}: ${reset.stderr.trim()}`,
    };
  }
  return { reverted: true, sha: snapshotData.sha };
}

// ---------------------------------------------------------------------------
// Test-only export
// ---------------------------------------------------------------------------

/** @internal — used by unit tests to verify same-session check */
export function _getSessionIdForTest() {
  return SESSION_ID;
}
