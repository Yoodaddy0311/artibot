/**
 * `spawnSync` with ONE retry for a child that died in the Windows loader.
 *
 * WHAT IT ABSORBS. Exit 3221225794 is 0xC0000142, STATUS_DLL_INIT_FAILED: the
 * process was created but a DLL initializer failed before any script ran.
 * Observed 2026-09-23 on `tests/ledger/session-coverage-cli.test.js` with the
 * child's stderr empty, while eight full vitest runs were in flight at once.
 * The recon for this helper counted it in 1 of 115 retained logs and did not
 * reproduce it in 855 spawns under a lighter load. The cause is not
 * established: desktop-heap / conhost exhaustion under burst spawning is the
 * working hypothesis, not a measured fact.
 *
 * WHY A RETRY IS NOT A LOOSENED ASSERTION. It fires only when the exit code is
 * that exact value AND stdout and stderr are both empty. A child that wrote
 * even one byte got far enough to be the code under test, and its result is
 * returned as is. So is every other exit code, including a second 0xC0000142:
 * the retry happens at most once, and the caller's assertions see whatever the
 * second attempt produced. Output not captured as a string or Buffer (`stdio:
 * 'ignore'` yields `null`) cannot be proven empty, so it never retries.
 *
 * IT IS NEVER SILENT. Each retry writes one line to this process's stderr, so
 * a run that needed it says so in the test log.
 *
 * WHAT THIS HELPER CANNOT SEE: whether the loader failure is transient. A
 * machine that fails this way on every spawn still fails, one attempt later.
 *
 * @module tests/helpers/spawn-retry
 */

import { spawnSync } from 'node:child_process';

/** 0xC0000142 STATUS_DLL_INIT_FAILED, as `spawnSync` reports it (unsigned). */
export const STATUS_DLL_INIT_FAILED = 3221225794;

/**
 * True only for captured output that holds zero bytes.
 * @param {unknown} out - `stdout` / `stderr` from a spawnSync result.
 * @returns {boolean}
 */
function isProvablyEmpty(out) {
  if (typeof out === 'string') return out.length === 0;
  return Buffer.isBuffer(out) && out.length === 0;
}

/**
 * Run `spawnSync(cmd, args, opts)`, retrying exactly once when the child died
 * with STATUS_DLL_INIT_FAILED and produced no output at all.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} opts
 * @param {{ spawn?: typeof spawnSync }} [deps] - Injection seam for tests.
 * @returns {import('node:child_process').SpawnSyncReturns<string|Buffer>}
 */
export function spawnSyncRetryDllInit(cmd, args, opts, { spawn = spawnSync } = {}) {
  const first = spawn(cmd, args, opts);
  const retry = first.status === STATUS_DLL_INIT_FAILED
    && isProvablyEmpty(first.stdout)
    && isProvablyEmpty(first.stderr);
  if (!retry) return first;
  process.stderr.write(
    `[spawn-retry] ${cmd} exited ${STATUS_DLL_INIT_FAILED} (0xC0000142 STATUS_DLL_INIT_FAILED) `
    + 'with no output; retrying once\n',
  );
  return spawn(cmd, args, opts);
}
