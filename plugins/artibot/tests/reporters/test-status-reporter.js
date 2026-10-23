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
 *     "schemaVersion": 3,
 *     "completion": { "reason": "passed", "unhandledErrorCount": 0, "unfinishedCount": 0 },
 *     "gitSha": "6149446eb5fc88d0537f07cb04010ba5ce4aa2a1",
 *     "gitDirty": false
 *   }
 *
 * Only failing test FILES are recorded — not individual test names — to keep
 * the file small and the SessionStart line readable.
 *
 * `gitSha` and `gitDirty` (v3) name the TREE the run measured: `git rev-parse
 * HEAD` and whether `git status --porcelain --untracked-files=no` printed
 * anything, both run in the plugin root. The freshness rule the Stop gate applies
 * (`lib/verification/deterministic-source.js`, owner decision F1) dates a run
 * against the last edit; it cannot say which commit the run covered, and the
 * REPORT gate's SHA binding (`.artibot/guides/v5-design/practicality-improvement-20261023/
 * 05_REVISED_DESIGN.md` D-04) needs exactly that. Both keys are OMITTED — never
 * `null`, never `''` — when git is missing, fails, times out or answers with
 * anything but a 40-hex id: an absent key means "identity not recorded", which
 * is a different claim from "the tree had no commit". The reader is injectable
 * (`new TestStatusReporter({ readGitIdentity })`) so the reporter's own tests do
 * not depend on their temp root being a repository.
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

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const OUTPUT_PATH = path.join(PLUGIN_ROOT, 'runtime', 'last-test-result.json');

/**
 * Bumped when a key is ADDED. 1 is the shape before `completion`, which never
 * wrote a version; 2 added `completion`; 3 added `gitSha` and `gitDirty`.
 */
const SCHEMA_VERSION = 3;

/** The values vitest 4 documents for `onTestRunEnd`'s third argument. Anything else is unknown. */
const RUN_END_REASONS = Object.freeze(['passed', 'interrupted', 'failed']);

/** A full object id as `git rev-parse HEAD` prints it. Anything else is not an identity. */
const SHA40 = /^[0-9a-f]{40}$/;

/**
 * How the two git calls run: in the plugin root (the tree the tests ran against),
 * with a bound so a hung git cannot hold the test run, and with stderr dropped so
 * "not a repository" stays silent. Measured 2026-10-23 on this checkout: ~3 ms for
 * `rev-parse` and ~5-7 ms for `status`, so the snapshot costs about 10 ms more.
 */
const GIT_OPTS = Object.freeze({
  cwd: PLUGIN_ROOT,
  encoding: 'utf-8',
  timeout: 5000,
  stdio: ['ignore', 'pipe', 'ignore'],
  windowsHide: true,
});

/**
 * The default identity reader: HEAD's full sha and whether tracked files differ
 * from it. Each call is guarded on its own, so a key is present exactly when its
 * call succeeded and answered in the promised shape. Never throws.
 *
 * @returns {{ gitSha?: string, gitDirty?: boolean }}
 */
export function defaultReadGitIdentity() {
  const identity = {};
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], GIT_OPTS).trim();
    if (SHA40.test(sha)) identity.gitSha = sha;
  } catch {
    // No git, not a repository, or timed out: the key stays absent.
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], GIT_OPTS);
    identity.gitDirty = status.trim().length > 0;
  } catch {
    // Same: an unanswered question is recorded by omission, never as a value.
  }
  return identity;
}

/**
 * Run an identity reader and keep only the well-formed keys. A reader that throws,
 * returns a non-object, or returns a key in the wrong shape contributes nothing
 * for that key — the snapshot must never carry a guessed identity, and a reader
 * fault must never cost the snapshot itself.
 *
 * @param {unknown} readGitIdentity
 * @returns {{ gitSha?: string, gitDirty?: boolean }}
 */
function identityOf(readGitIdentity) {
  let raw;
  try {
    raw = typeof readGitIdentity === 'function' ? readGitIdentity() : {};
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const identity = {};
  if (typeof raw.gitSha === 'string' && SHA40.test(raw.gitSha)) identity.gitSha = raw.gitSha;
  if (typeof raw.gitDirty === 'boolean') identity.gitDirty = raw.gitDirty;
  return identity;
}

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
  /**
   * @param {{ readGitIdentity?: () => { gitSha?: string, gitDirty?: boolean } }} [options]
   *   `readGitIdentity` replaces the two git calls (tests inject it; vitest passes
   *   nothing). Anything that is not a function falls back to the default reader.
   */
  constructor(options = {}) {
    this.startedAt = Date.now();
    this.readGitIdentity = typeof options?.readGitIdentity === 'function'
      ? options.readGitIdentity
      : defaultReadGitIdentity;
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

      const measurement = {
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
      // The identity rides beside the measurement and is read AFTER the counts, so
      // a slow or absent git delays nothing the counts depend on and omits itself.
      const payload = { ...measurement, ...identityOf(this.readGitIdentity) };
      mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
      writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    } catch {
      // Never let the reporter break the test run. SessionStart will simply
      // see the previous snapshot (or no snapshot) on the next start.
    }
  }
}
