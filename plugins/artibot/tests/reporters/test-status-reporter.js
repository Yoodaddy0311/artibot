/**
 * Vitest reporter that writes `runtime/last-test-result.json` after every
 * test run. Consumed by `lib/core/test-status.js` on SessionStart.
 *
 * Schema (kept compact — SessionStart reads this on every start):
 *   {
 *     "timestamp": "2026-05-16T15:30:00.000Z",
 *     "totalTests": 7736,
 *     "passed": 7716,
 *     "failed": 20,
 *     "skipped": 0,
 *     "failedFiles": ["tests/cron/auto-cleanup-runner.test.js", ...],
 *     "durationMs": 18045
 *   }
 *
 * Only failing test FILES are recorded — not individual test names — to keep
 * the file small and the SessionStart line readable.
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
   */
  onTestRunEnd(testModules = []) {
    try {
      let totalTests = 0;
      let passed = 0;
      let failed = 0;
      let skipped = 0;
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
        }
      }

      const payload = {
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - this.startedAt,
        totalTests,
        passed,
        failed,
        skipped,
        failedFiles: Array.from(failedFiles).sort(),
      };
      mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
      writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    } catch {
      // Never let the reporter break the test run. SessionStart will simply
      // see the previous snapshot (or no snapshot) on the next start.
    }
  }
}
