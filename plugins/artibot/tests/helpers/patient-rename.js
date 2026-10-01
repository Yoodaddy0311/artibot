/**
 * A `renameSync` that outlasts a Windows destination lock for longer than the
 * store's own retry budget, for tests that commit to a REAL StateStore in a
 * tight loop.
 *
 * WHAT IT ABSORBS. `state-manager.js#commitLocked` ends every commit with
 * `atomicWriteTextSync(snapshot)`, whose rename retries 5 attempts, about 150ms
 * (`lib/core/file.js#renameWithRetry`, 10-20-40-80ms). On Windows a rename onto
 * an existing file fails with EPERM while antivirus or the indexer still holds
 * the destination, and under a loaded host that outlasts 150ms. Observed
 * 2026-10-01 in `tests/scripts/lease-tick.test.js`: the 32-renewal loop failed
 * `expected 31 to be 32` in 1 of 3 runs of a 12-file batch (the same test alone
 * passed). A replay of that loop 40 times (~1,400 commits) beside the same 12
 * files caught it once more, and the poll's outcome was
 * `skipped:store-threw:EPERM: operation not permitted, rename '<store>/
 * project-state.json.tmp.<pid>.<ts>.<id>' -> '<store>/project-state.json'`.
 * The journal had already taken that write (the lease's heartbeat had moved and
 * `state_version` was 29 = 3 setup commits + 26 renewals): only the snapshot,
 * which is a cache of the journal, failed to land. The test counts outcomes, so
 * a renewal that happened was reported as one that did not.
 *
 * MEASURED EFFECT (2026-10-01 07:06-07:12Z, one process, 200 replays of that
 * loop alternating plain and patient, while an 11-file batch looped beside it):
 * plain, 5 of 100 replays ended at 31 renewals, every one with the EPERM above;
 * patient, 0 of 100. Of the patient arm's 3,200 renames 117 needed a second
 * attempt or more, and 6 needed 6 to 8 attempts, which core's five would not
 * have survived. Both arms are small and the load was this development
 * machine's own, not a CI runner's; read the numbers as "the cause is the
 * budget", not as a rate.
 *
 * WHY THIS IS NOT A LOOSENED ASSERTION. It touches no expectation and no code
 * under test. It retries ONLY a rename that fails with one of core's own
 * transient codes (`TRANSIENT_RENAME_CODES`: EPERM, EBUSY, EACCES), for a
 * bounded 12 attempts with each sleep capped at 250ms (about 1.8s), then
 * rethrows the original error. Any other code (ENOENT, EXDEV, ...) is thrown on
 * the first attempt, and so is a transient code that persists past the budget.
 * The retry is the one core already makes, with a longer breath; `session-store`
 * took the same step (8 attempts, 250ms cap) after its own flake.
 *
 * IT IS NEVER SILENT. A rename that needed a second attempt writes one line to
 * this process's stderr, so a run that leaned on it says so in the test log.
 *
 * WHAT THIS HELPER CANNOT SEE. It wraps `fs.renameSync` of THIS process only:
 * a child process (the `lease-tick-wiring` scripts) is not covered. It does not
 * cover any other call of the commit path: the journal append, the lock create
 * (core waits up to 2s for it), the unlink. A destination held for longer than
 * ~1.8s still fails. And it says nothing about production, whose budget stays
 * the ~150ms that `tests/core/file.test.js` pins: a test that ran with this
 * helper installed proves nothing about how often a real tick meets the lock.
 *
 * @module tests/helpers/patient-rename
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { sleepSync, TRANSIENT_RENAME_CODES } from '../../lib/core/file.js';

/** Attempts per rename, the first included. Core's own budget is 5. */
export const PATIENT_ATTEMPTS = 12;

/** Ceiling (ms) for one backoff sleep; the doubling from 10ms is core's own. */
export const PATIENT_MAX_BACKOFF_MS = 250;

/**
 * Wrap a rename so a transient Windows destination lock is waited out.
 *
 * @param {(from: string, to: string) => unknown} rename - The rename to wrap.
 * @param {object} [opts]
 * @param {number} [opts.attempts=PATIENT_ATTEMPTS] - Total attempts including the first.
 * @param {number} [opts.maxBackoffMs=PATIENT_MAX_BACKOFF_MS] - Ceiling for a single sleep.
 * @param {(ms: number) => void} [opts.sleep] - Injection seam; defaults to core's `sleepSync`.
 * @param {(line: string) => void} [opts.log] - Injection seam; defaults to this process's stderr.
 * @returns {(from: string, to: string) => unknown} Returns what `rename` returned; rethrows its original error.
 */
export function patientRename(rename, {
  attempts = PATIENT_ATTEMPTS,
  maxBackoffMs = PATIENT_MAX_BACKOFF_MS,
  sleep = sleepSync,
  log = (line) => process.stderr.write(line),
} = {}) {
  return (from, to) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const out = rename(from, to);
        if (attempt > 1) log(`[patient-rename] rename onto ${path.basename(String(to))} landed on attempt ${attempt} of ${attempts}\n`);
        return out;
      } catch (err) {
        if (!TRANSIENT_RENAME_CODES.has(err?.code) || attempt >= attempts) throw err;
        sleep(Math.min(10 * 2 ** (attempt - 1), maxBackoffMs));
      }
    }
  };
}

/**
 * Replace `fs.renameSync` with {@link patientRename} of itself. Core reaches it
 * as `fsSync.renameSync(...)` on the default import of `node:fs`, which this
 * spy sees (a named import would not be).
 *
 * @param {object} [opts] - {@link patientRename} options, plus `rename`.
 * @param {(from: string, to: string) => unknown} [opts.rename] - The rename underneath; defaults to the current `fs.renameSync`.
 * @returns {() => void} Restores `fs.renameSync`.
 */
export function installPatientRename({ rename = fs.renameSync, ...opts } = {}) {
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation(patientRename(rename, opts));
  return () => spy.mockRestore();
}

/**
 * Install {@link installPatientRename} around every test of the calling file or
 * `describe`: `beforeEach` installs, `afterEach` restores.
 *
 * @param {object} [opts] - {@link installPatientRename} options.
 * @returns {void}
 */
export function usePatientRename(opts) {
  let restore = null;
  beforeEach(() => { restore = installPatientRename(opts); });
  afterEach(() => {
    restore?.();
    restore = null;
  });
}
