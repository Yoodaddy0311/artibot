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
 * Longest failing-file label the warning echoes. A plugin-relative test path is well under
 * this; it keeps one broken or hostile `failedFiles` entry from flooding the banner line.
 */
const FAILED_FILE_ECHO_MAX = 120;

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
 * How long ago the snapshot was recorded: `15m ago`, `1.5h ago`. A snapshot dated ahead of
 * this clock (skew, or a file written under a wrong clock) has no age; it says `30m in the
 * future` rather than a negative number, and one under half a minute ahead still reads `0m ago`.
 *
 * @param {number} ageHours negative when the snapshot is dated ahead of now
 * @returns {string}
 */
function describeAge(ageHours) {
  const span = Math.abs(ageHours);
  const amount = span < 1 ? `${Math.round(span * 60)}m` : `${span.toFixed(1)}h`;
  return ageHours < 0 && amount !== '0m' ? `${amount} in the future` : `${amount} ago`;
}

/**
 * The failing-file labels the warning may echo, in file order. `failedFiles` is read from a
 * file anything can write, and the warning is one line handed to the model as well as the
 * user, so each label is made safe to sit on that line: only strings are labels; control and
 * format characters (a newline, an ANSI escape, a bidi override) and runs of whitespace become
 * one space; a label past FAILED_FILE_ECHO_MAX is cut and marked with an ellipsis; what is
 * empty once cleaned is not a label.
 *
 * @param {unknown} failedFiles `failedFiles` as read from disk, so any shape
 * @returns {string[]}
 */
function failedFileLabels(failedFiles) {
  if (!Array.isArray(failedFiles)) return [];
  const labels = [];
  for (const entry of failedFiles) {
    if (typeof entry !== 'string') continue;
    const label = entry.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
    if (label === '') continue;
    labels.push(label.length > FAILED_FILE_ECHO_MAX ? `${label.slice(0, FAILED_FILE_ECHO_MAX)}…` : label);
  }
  return labels;
}

/**
 * The SessionStart line for a snapshot that is not stale, or `null` when nothing is
 * wrong. A failing test leads and its text is as it always was; how the run ended only
 * follows it, so the failing files are never pushed aside. With no failing test the end
 * of the run is all that can still be wrong, and it warns on its own.
 *
 * @param {{ failed: number, failedFiles: unknown }} summary `failed` is a count
 * @param {any} completion `completion` as read from disk, so any shape
 * @param {number} ageHours
 * @returns {string | null}
 */
function formatWarning({ failed, failedFiles }, completion, ageHours) {
  const ageHint = describeAge(ageHours);
  const badEnd = badEndFacts(completion);

  if (failed === 0) {
    return badEnd === null
      ? null
      : `[artibot:test-status] last test run did not end cleanly (${badEnd}) recorded ${ageHint}`;
  }

  const labels = failedFileLabels(failedFiles);
  const sample = labels.slice(0, 3).join(', ');
  const extra = labels.length > 3 ? ` (+${labels.length - 3} more)` : '';
  const where = labels.length === 0 ? '' : ` — ${sample}${extra}`;
  const endClause = badEnd === null ? '' : ` — run also did not end cleanly (${badEnd})`;
  return `[artibot:test-status] ${failed} failing test(s) recorded ${ageHint}`
    + `${where}${endClause}`;
}

/**
 * What the reader returns when there is no snapshot to read: a missing file, an unreadable
 * one, or a record whose `failed` is not a count. A new object each time, never a shared one.
 *
 * @returns {{ exists: false, stale: false, ageHours: null, summary: null, warning: null }}
 */
function noSnapshot() {
  return { exists: false, stale: false, ageHours: null, summary: null, warning: null };
}

/**
 * Read the last test result with TTL guard. A record whose `failed` is present but is not a
 * count (negative, fractional, overflowed, or not a number) is not a snapshot: its other
 * numbers cannot be vouched for either, and `failed` is never rounded, clamped or defaulted
 * to 0, which would read as a pass.
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

  if (!existsSync(statusPath)) return noSnapshot();

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statusPath, 'utf-8'));
  } catch {
    parsed = null;
  }

  // Unreadable, unparseable, or the JSON text `null` (which parses fine and has no
  // properties to read): none of them is a snapshot, so all of them are "no snapshot".
  if (parsed === null) return noSnapshot();

  const ts = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
  if (Number.isNaN(ts)) {
    return { exists: true, stale: true, ageHours: null, summary: null, warning: null };
  }

  // `failed` counts tests, so what is not a count (-3, 1.5, 1e999, "3", null) is no measurement
  // of any run. A record without the key at all is the old shape and still reads as 0 below.
  if (parsed.failed !== undefined && !isCount(parsed.failed)) return noSnapshot();

  const ageHours = (now() - ts) / 3_600_000;
  const stale = ageHours > ttlHours;
  const failed = isCount(parsed.failed) ? parsed.failed : 0;
  const passed = Number.isFinite(parsed.passed) ? parsed.passed : 0;
  const totalTests = Number.isFinite(parsed.totalTests) ? parsed.totalTests : passed + failed;
  const failedFiles = Array.isArray(parsed.failedFiles) ? parsed.failedFiles : [];

  const summary = { totalTests, passed, failed, failedFiles };

  // A stale snapshot describes a tree that has since moved on: it never warns.
  const warning = stale ? null : formatWarning(summary, parsed.completion, ageHours);

  return { exists: true, stale, ageHours, summary, warning };
}
