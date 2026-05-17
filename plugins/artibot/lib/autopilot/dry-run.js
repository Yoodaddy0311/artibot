/**
 * Dry-run utilities for autopilot phases.
 *
 * Provides:
 *   - `createDryRunGitRunner()` — a fake git runner that logs every call
 *     without executing anything. Drop-in replacement for the execFileSync-
 *     based runners in phase-diff / rollback / cross-machine.
 *   - `wrapPhaseForDryRun(phaseFn)` — HOF that intercepts file-write side
 *     effects on the injected fs facade so phase code can run end-to-end
 *     while changing nothing on disk.
 *
 * DATA POLICY: pure in-memory operations. No file IO, no network, no shell.
 *
 * @module lib/autopilot/dry-run
 */

/**
 * Build a dry-run git runner. Records every invocation in `.calls` and
 * returns deterministic empty stdout (or whatever the caller queued via
 * `.respondWith`).
 *
 * @returns {{
 *   runner: (args: string[], cwd: string) => string,
 *   calls: Array<{ args: string[], cwd: string }>,
 *   respondWith: (responder: (args: string[], cwd: string) => string) => void,
 *   reset: () => void
 * }}
 */
export function createDryRunGitRunner() {
  const calls = [];
  let responder = null;
  const runner = (args, cwd) => {
    const safeArgs = Array.isArray(args) ? args.slice() : [];
    const safeCwd = typeof cwd === 'string' ? cwd : '';
    calls.push({ args: safeArgs, cwd: safeCwd });
    if (typeof responder === 'function') {
      try {
        const out = responder(safeArgs, safeCwd);
        return typeof out === 'string' ? out : '';
      } catch {
        return '';
      }
    }
    return '';
  };
  return {
    runner,
    calls,
    respondWith(fn) { responder = typeof fn === 'function' ? fn : null; },
    reset() { calls.length = 0; responder = null; },
  };
}

/**
 * Set of fs facade method names treated as "writes" in dry-run.
 * The wrapped fs returned by wrapPhaseForDryRun replaces these with no-ops.
 */
const FS_WRITE_METHODS = new Set([
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'renameSync',
  'unlinkSync',
  'rmSync',
  'rmdirSync',
  'copyFileSync',
  'chmodSync',
  'symlinkSync',
  'truncateSync',
]);

/**
 * Build a dry-run fs facade. Read methods pass through to the source fs;
 * write methods become no-ops and are logged into `.writes`.
 * @param {object} sourceFs - typically the real `node:fs` module
 * @returns {{ fs: object, writes: Array<{ method: string, args: unknown[] }> }}
 */
function buildDryRunFs(sourceFs) {
  const writes = [];
  const fs = { ...sourceFs };
  for (const method of FS_WRITE_METHODS) {
    if (typeof sourceFs[method] === 'function') {
      fs[method] = (...args) => {
        writes.push({ method, args });
        return undefined;
      };
    }
  }
  return { fs, writes };
}

/**
 * Higher-order wrapper. Returns a new function that invokes `phaseFn`
 * with an `opts` argument augmented to include:
 *   - `dryRun: true`
 *   - `gitRunner`: dry-run git runner (if caller did not supply one)
 *   - `fs`: write-blocking fs facade (when `opts.fs` is omitted)
 *
 * The returned function also attaches `.dryRunCalls` / `.dryRunWrites`
 * to its return value when the result is an object — non-object results
 * are returned unchanged.
 *
 * @template T
 * @param {(opts: object) => T} phaseFn
 * @param {{ sourceFs?: object }} [wrapOpts]
 * @returns {(opts?: object) => T}
 */
export function wrapPhaseForDryRun(phaseFn, wrapOpts = {}) {
  if (typeof phaseFn !== 'function') {
    throw new TypeError('wrapPhaseForDryRun: phaseFn must be a function');
  }
  return function dryRunWrapped(opts = {}) {
    const userOpts = opts && typeof opts === 'object' ? opts : {};
    const fsFacade = userOpts.fs && typeof userOpts.fs === 'object'
      ? { fs: userOpts.fs, writes: [] }
      : buildDryRunFs(wrapOpts.sourceFs || {});
    const gitFacade = typeof userOpts.gitRunner === 'function'
      ? { runner: userOpts.gitRunner, calls: [] }
      : createDryRunGitRunner();
    const merged = {
      ...userOpts,
      dryRun: true,
      gitRunner: gitFacade.runner,
      fs: fsFacade.fs,
    };
    const result = phaseFn(merged);
    if (result && typeof result === 'object') {
      return {
        ...result,
        dryRunCalls: gitFacade.calls,
        dryRunWrites: fsFacade.writes,
      };
    }
    return result;
  };
}
