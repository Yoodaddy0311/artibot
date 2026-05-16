/**
 * WIP commit statistics for autopilot squash advisory.
 *
 * v4.7.8 raised the WIP commit interval to 120m and set squashWipOnClose to
 * false by default. That removes the historical "auto-squash on close" safety
 * net, so WIP commits can accumulate silently across sessions. This module
 * surfaces accumulation so SessionStart can advise the user to run the
 * /squash command before pushing.
 *
 * All public helpers return safe defaults (0, 0, false) on git failures so
 * the SessionStart banner never throws or blocks on a degraded git state.
 *
 * @module lib/autopilot/wip-stats
 */

import { execSync } from 'node:child_process';

/** Default threshold counts (overridable per call). */
export const DEFAULT_COUNT_THRESHOLD = 10;
export const DEFAULT_AGE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4h

// Match: `wip:`, `WIP:`, `wip(scope):`, `WIP `, leading `[WIP]`.
// Lowercased subject is tested, so we only need a lower-case pattern.
const WIP_SUBJECT_RE = /^(\[wip\]|wip\b|wip:|wip\()/i;

/**
 * Default git runner. Returns trimmed stdout. Throws on non-zero exit so
 * callers can fall through to their safe defaults.
 *
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
function defaultGitRunner(args, opts = {}) {
  return execSync(`git ${args.join(' ')}`, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

/**
 * Decide whether a commit subject line counts as a WIP commit.
 *
 * @param {string} subject
 * @returns {boolean}
 */
export function isWipSubject(subject) {
  if (typeof subject !== 'string') return false;
  return WIP_SUBJECT_RE.test(subject.trim());
}

/**
 * Count WIP commits reachable from `branch` (HEAD by default), optionally
 * limited via `since` (a git-recognized timestamp or relative date such as
 * `2 days ago`). Returns 0 on any git error.
 *
 * @param {string} [branch='HEAD']
 * @param {{ since?: string, git?: (args: string[], opts?: object) => string, cwd?: string }} [opts]
 * @returns {number}
 */
export function countWipCommits(branch = 'HEAD', opts = {}) {
  const git = opts.git ?? defaultGitRunner;
  const args = ['log', '--pretty=%s'];
  if (opts.since) args.push(`--since=${JSON.stringify(opts.since)}`);
  args.push(branch);
  args.push('--');

  let out;
  try {
    out = git(args, { cwd: opts.cwd });
  } catch {
    return 0;
  }
  if (!out) return 0;

  let count = 0;
  for (const line of out.split('\n')) {
    if (isWipSubject(line)) count += 1;
  }
  return count;
}

/**
 * Return the age (in milliseconds) of the oldest WIP commit reachable from
 * `branch`. Returns 0 if no WIP commit exists or git fails.
 *
 * @param {string} [branch='HEAD']
 * @param {{ git?: (args: string[], opts?: object) => string, cwd?: string, now?: () => number }} [opts]
 * @returns {number}
 */
export function getOldestWipAgeMs(branch = 'HEAD', opts = {}) {
  const git = opts.git ?? defaultGitRunner;
  const now = opts.now ?? Date.now;
  // Tab-separated: epoch seconds <TAB> subject. Tab is safer than space because
  // commit subjects contain spaces.
  const args = ['log', '--pretty=%at%x09%s', branch, '--'];

  let out;
  try {
    out = git(args, { cwd: opts.cwd });
  } catch {
    return 0;
  }
  if (!out) return 0;

  let oldestEpochSec = null;
  for (const line of out.split('\n')) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) continue;
    const epochStr = line.slice(0, tabIdx);
    const subject = line.slice(tabIdx + 1);
    if (!isWipSubject(subject)) continue;
    const epoch = Number(epochStr);
    if (!Number.isFinite(epoch)) continue;
    if (oldestEpochSec === null || epoch < oldestEpochSec) {
      oldestEpochSec = epoch;
    }
  }

  if (oldestEpochSec === null) return 0;
  const ageMs = now() - oldestEpochSec * 1000;
  return ageMs > 0 ? ageMs : 0;
}

/**
 * Decide whether the advisory line should fire. Either threshold being met
 * triggers a suggestion (i.e. accumulation OR stale age is enough on its own).
 *
 * Threshold semantics: strict `>=` for count, strict `>=` for age — exactly
 * at the threshold counts as "suggest". This matches user expectations for
 * a soft advisory and is covered by boundary tests.
 *
 * @param {number} count
 * @param {number} ageMs
 * @param {{ countThreshold?: number, ageThresholdMs?: number }} [opts]
 * @returns {boolean}
 */
export function shouldSuggestSquash(count, ageMs, opts = {}) {
  const countThreshold = opts.countThreshold ?? DEFAULT_COUNT_THRESHOLD;
  const ageThresholdMs = opts.ageThresholdMs ?? DEFAULT_AGE_THRESHOLD_MS;
  if (!Number.isFinite(count) || !Number.isFinite(ageMs)) return false;
  if (count <= 0) return false; // No WIP commits → never suggest.
  return count >= countThreshold || ageMs >= ageThresholdMs;
}

/**
 * Format the human-readable advisory line shown on SessionStart. The shape
 * mirrors `[artibot:test-status]` from lib/core/test-status.js — a single
 * `[artibot:wip]` prefix followed by count, oldest age, and action hint.
 *
 * Returns null when no suggestion should fire (caller can simply not push
 * a line).
 *
 * @param {number} count
 * @param {number} ageMs
 * @param {{ countThreshold?: number, ageThresholdMs?: number }} [opts]
 * @returns {string | null}
 */
export function formatAdvisoryLine(count, ageMs, opts = {}) {
  if (!shouldSuggestSquash(count, ageMs, opts)) return null;
  const ageHours = ageMs / 3_600_000;
  const ageHint = ageHours < 1
    ? `${Math.max(1, Math.round(ageMs / 60_000))}m`
    : `${ageHours.toFixed(ageHours >= 10 ? 0 : 1)}h`;
  return `[artibot:wip] ${count} WIP commit(s) (oldest ${ageHint} ago) — consider /squash before push`;
}

/**
 * Read both count + age thresholds from environment variables when present.
 * Recognized keys (advisory — fall back to defaults on invalid input):
 *   - ARTIBOT_WIP_COUNT_THRESHOLD (integer, e.g. "5")
 *   - ARTIBOT_WIP_AGE_HOURS       (number, e.g. "2.5")
 *
 * @returns {{ countThreshold: number, ageThresholdMs: number }}
 */
export function resolveThresholdsFromEnv() {
  let countThreshold = DEFAULT_COUNT_THRESHOLD;
  let ageThresholdMs = DEFAULT_AGE_THRESHOLD_MS;

  const rawCount = process.env.ARTIBOT_WIP_COUNT_THRESHOLD;
  if (rawCount !== undefined) {
    const n = Number(rawCount);
    if (Number.isFinite(n) && n > 0) countThreshold = Math.floor(n);
  }

  const rawHours = process.env.ARTIBOT_WIP_AGE_HOURS;
  if (rawHours !== undefined) {
    const h = Number(rawHours);
    if (Number.isFinite(h) && h > 0) ageThresholdMs = h * 3_600_000;
  }

  return { countThreshold, ageThresholdMs };
}
