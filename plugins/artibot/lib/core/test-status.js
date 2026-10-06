/**
 * Test-status reader for SessionStart banner.
 *
 * Reads `runtime/last-test-result.json` (written by the vitest reporter at
 * `tests/reporters/test-status-reporter.js`) and produces a single-line
 * stderr warning when there are recent failures. Never throws — every code
 * path resolves to `{ warning: null }` on missing/corrupt/stale data.
 *
 * Why this exists: the audit on 2026-05-16 flagged that the dispatcher
 * regression + 19 other failures sat undetected for hours because nothing
 * surfaced them on SessionStart. The user had to run `npm test` manually.
 * This module turns the next session-start into the implicit reminder.
 *
 * A run can also end badly without failing a single test: an unobserved
 * rejection, a hook that throws inside a `describe`, a killed worker and an
 * interrupted run all leave `failed: 0` while vitest exits 1 (measured on
 * vitest 4.0.18; VERIFICATION-ECONOMICS-DESIGN §3.2). The reporter records how
 * the run ended in `completion`, so a snapshot that carries it warns on that
 * too: on its own when no test failed, after the failing-tests text when some
 * did. One that does not (the reporter before 2026-10-06), or whose
 * `completion` cannot be read, stays silent exactly as before: unknown is not
 * a bad end.
 *
 * @module lib/core/test-status
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TTL_HOURS = 24;
const STATE_REL_PATH = ['runtime', 'last-test-result.json'];

/**
 * The values vitest 4 documents for `onTestRunEnd`'s third argument, which the
 * reporter writes verbatim as `completion.reason`. `lib/core` may not import
 * `lib/verification` and nothing in `lib` imports the reporter, so this reader
 * keeps its own copy of the vocabulary; `tests/core/test-status.test.js` runs
 * the reporter's real output through it to keep the two in step.
 */
const COMPLETION_REASONS = ['passed', 'interrupted', 'failed'];

/** @param {unknown} v @returns {boolean} A count the reporter could have written. */
function isCount(v) {
  return Number.isInteger(v) && v >= 0;
}

/**
 * How vitest ended the run, as `vitest reason=..., unhandled=..., unfinished=...`,
 * when it ended it badly; `null` when it ended well or the record cannot say.
 *
 * Each `completion` field is read on its own. One that is missing or mistyped
 * is UNKNOWN: it is shown as `unknown`, never defaulted to a value that would
 * read as a clean run, and never enough to warn by itself. The `reason` is
 * checked against the vocabulary so nothing but a known word is echoed from
 * the file into the banner.
 *
 * @param {any} completion `completion` as read from disk, so any shape
 * @returns {string | null}
 */
function badEndFacts(completion) {
  if (completion === null || typeof completion !== 'object') return null;

  const reason = COMPLETION_REASONS.includes(completion.reason) ? completion.reason : null;
  const unhandled = isCount(completion.unhandledErrorCount) ? completion.unhandledErrorCount : null;
  const unfinished = isCount(completion.unfinishedCount) ? completion.unfinishedCount : null;

  const endedBadly = reason === 'failed' || reason === 'interrupted'
    || (unhandled ?? 0) > 0 || (unfinished ?? 0) > 0;
  if (!endedBadly) return null;

  return `vitest reason=${reason ?? 'unknown'}, unhandled=${unhandled ?? 'unknown'},`
    + ` unfinished=${unfinished ?? 'unknown'}`;
}

/**
 * The SessionStart line for a snapshot that is not stale, or `null` when nothing is
 * wrong. A failing test leads and its text is as it always was; how the run ended only
 * follows it, so the failing files are never pushed aside. With no failing test the end
 * of the run is all that can still be wrong, and it warns on its own.
 *
 * @param {{ failed: number, failedFiles: string[] }} summary
 * @param {any} completion `completion` as read from disk, so any shape
 * @param {number} ageHours
 * @returns {string | null}
 */
function formatWarning({ failed, failedFiles }, completion, ageHours) {
  const ageHint = ageHours < 1
    ? `${Math.round(ageHours * 60)}m ago`
    : `${ageHours.toFixed(1)}h ago`;
  const badEnd = badEndFacts(completion);

  if (failed === 0) {
    return badEnd === null
      ? null
      : `[artibot:test-status] last test run did not end cleanly (${badEnd}) recorded ${ageHint}`;
  }

  const sample = failedFiles.slice(0, 3).join(', ');
  const extra = failedFiles.length > 3 ? ` (+${failedFiles.length - 3} more)` : '';
  const endClause = badEnd === null ? '' : ` — run also did not end cleanly (${badEnd})`;
  return `[artibot:test-status] ${failed} failing test(s) recorded ${ageHint}`
    + ` — ${sample}${extra}${endClause}`;
}

/**
 * Read the last test result with TTL guard.
 *
 * @param {string} pluginRoot
 * @param {{ ttlHours?: number, now?: () => number }} [options]
 * @returns {{
 *   exists: boolean,
 *   stale: boolean,
 *   ageHours: number | null,
 *   summary: { totalTests: number, passed: number, failed: number, failedFiles: string[] } | null,
 *   warning: string | null
 * }}
 */
export function getLastTestStatus(pluginRoot, options = {}) {
  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;
  const now = options.now ?? Date.now;
  const statusPath = path.join(pluginRoot, ...STATE_REL_PATH);

  if (!existsSync(statusPath)) {
    return { exists: false, stale: false, ageHours: null, summary: null, warning: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statusPath, 'utf-8'));
  } catch {
    parsed = null;
  }

  // Unreadable, unparseable, or the JSON text `null` (which parses fine and has no
  // properties to read): none of them is a snapshot, so all of them are "no snapshot".
  if (parsed === null) {
    return { exists: false, stale: false, ageHours: null, summary: null, warning: null };
  }

  const ts = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
  if (Number.isNaN(ts)) {
    return { exists: true, stale: true, ageHours: null, summary: null, warning: null };
  }

  const ageHours = (now() - ts) / 3_600_000;
  const stale = ageHours > ttlHours;
  const failed = Number.isFinite(parsed.failed) ? parsed.failed : 0;
  const passed = Number.isFinite(parsed.passed) ? parsed.passed : 0;
  const totalTests = Number.isFinite(parsed.totalTests) ? parsed.totalTests : passed + failed;
  const failedFiles = Array.isArray(parsed.failedFiles) ? parsed.failedFiles : [];

  const summary = { totalTests, passed, failed, failedFiles };

  // A stale snapshot describes a tree that has since moved on: it never warns.
  const warning = stale ? null : formatWarning(summary, parsed.completion, ageHours);

  return { exists: true, stale, ageHours, summary, warning };
}
