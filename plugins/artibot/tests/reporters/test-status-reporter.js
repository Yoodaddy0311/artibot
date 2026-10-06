/**
 * Vitest reporter that writes `runtime/last-test-result.json` after every
 * test run. Consumed by `lib/core/test-status.js` on SessionStart.
 *
 * Schema (kept compact — SessionStart reads this on every start):
 *   {
 *     "timestamp": "2026-05-16T15:30:00.000Z",
 *     "modules": 1204,
 *     "totalTests": 7736,
 *     "passed": 7716,
 *     "failed": 20,
 *     "skipped": 0,
 *     "failedFiles": ["tests/cron/auto-cleanup-runner.test.js", ...],
 *     "durationMs": 18045,
 *     "schemaVersion": 2,
 *     "completion": { "reason": "passed", "unhandledErrorCount": 0, "unfinishedCount": 0 }
 *   }
 *
 * Only failing test FILES are recorded — not individual test names — to keep
 * the file small and the SessionStart line readable.
 *
 * `modules` is the number of test FILES the run collected. It exists because
 * every downstream reader of this snapshot — `lib/core/test-status.js` and the
 * Stop gate's `lib/verification/deterministic-source.js` — previously had only
 * the four test counts and so could not tell a whole-suite run from a targeted
 * one. It narrows that, it does not settle it: a filter that happens to match
 * every file counts the same as no filter at all. The reporter API exposes no
 * filter, so the honest field is the count, not a "was targeted" boolean.
 *
 * `schemaVersion` and `completion` say how the RUN ended, which the four test
 * counts cannot: an unobserved rejection, a timer that throws, a hook that
 * throws inside a `describe`, a killed worker and an interrupted run all leave
 * `failed: 0` while vitest itself exits 1 (VERIFICATION-ECONOMICS-DESIGN §3.2).
 * `reason` is vitest's own verdict, `unhandledErrorCount` its count of errors
 * raised outside any test, `unfinishedCount` the tests that reached no final
 * state. The first two are independent: an unobserved rejection ends with
 * reason 'passed' AND one unhandled error. UNKNOWN IS `null` — a caller that
 * hands over only the modules has told us nothing about the end of the run, and
 * writing 0 or 'passed' there would be a measurement nobody made.
 *
 * Vitest 4 reporter API: onInit + onTestRunStart + onTestRunEnd.
 *
 * @module tests/reporters/test-status-reporter
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const OUTPUT_PATH = path.join(PLUGIN_ROOT, 'runtime', 'last-test-result.json');

/** Bumped when a key is ADDED. 1 is the shape before `completion`, which never wrote a version. */
const SCHEMA_VERSION = 2;

/** The values vitest 4 documents for `onTestRunEnd`'s third argument. Anything else is unknown. */
const RUN_END_REASONS = Object.freeze(['passed', 'interrupted', 'failed']);

/**
 * Convert an absolute module path to a forward-slash plugin-relative label
 * for the snapshot file.
 *
 * @param {string} moduleId
 * @returns {string}
 */
function toRelativeLabel(moduleId) {
  if (!moduleId) return '';
  return path.relative(PLUGIN_ROOT, moduleId).replace(/\\/g, '/');
}

export default class TestStatusReporter {
  constructor() {
    this.startedAt = Date.now();
  }

  onInit() {
    this.startedAt = Date.now();
  }

  onTestRunStart() {
    this.startedAt = Date.now();
  }

  /**
   * Vitest 4 hook — called once after the entire run finishes.
   *
   * @param {ReadonlyArray<{ moduleId: string, errors: () => any[], children: { allTests: (state?: string) => Iterable<{ result: () => { state: string } }> } }>} testModules
   * @param {ReadonlyArray<unknown>} [unhandledErrors] Errors raised outside any test.
   * @param {'passed'|'interrupted'|'failed'} [reason] Vitest's own verdict on the run.
   */
  onTestRunEnd(testModules = [], unhandledErrors, reason) {
    try {
      let totalTests = 0;
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      let unfinished = 0;
      const failedFiles = new Set();

      for (const mod of testModules) {
        const label = toRelativeLabel(mod.moduleId);
        // Collection-time error: counts as a single failure for this file.
        const collectionErrors = typeof mod.errors === 'function' ? mod.errors() : [];
        if (Array.isArray(collectionErrors) && collectionErrors.length > 0) {
          failed += 1;
          if (label) failedFiles.add(label);
        }

        for (const test of mod.children.allTests()) {
          totalTests += 1;
          const state = test.result()?.state;
          if (state === 'passed') passed += 1;
          else if (state === 'failed') {
            failed += 1;
            if (label) failedFiles.add(label);
          } else if (state === 'skipped') skipped += 1;
          // Keyed on the STATE, never on `options.mode`: `ctx.skip()` ends as
          // state 'skipped' under mode 'run' and is a final state, so counting by
          // mode would call a clean run unfinished on whichever host skips.
          else unfinished += 1;
        }
      }

      const payload = {
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - this.startedAt,
        modules: Array.isArray(testModules) ? testModules.length : 0,
        totalTests,
        passed,
        failed,
        skipped,
        failedFiles: Array.from(failedFiles).sort(),
        schemaVersion: SCHEMA_VERSION,
        completion: {
          reason: RUN_END_REASONS.includes(reason) ? reason : null,
          unhandledErrorCount: Array.isArray(unhandledErrors) ? unhandledErrors.length : null,
          unfinishedCount: unfinished,
        },
      };
      mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
      writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    } catch {
      // Never let the reporter break the test run. SessionStart will simply
      // see the previous snapshot (or no snapshot) on the next start.
    }
  }
}
