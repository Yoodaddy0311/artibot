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
 * @module lib/core/test-status
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TTL_HOURS = 24;
const STATE_REL_PATH = ['runtime', 'last-test-result.json'];

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

  if (stale || failed === 0) {
    return { exists: true, stale, ageHours, summary, warning: null };
  }

  const sample = failedFiles.slice(0, 3).join(', ');
  const extra = failedFiles.length > 3 ? ` (+${failedFiles.length - 3} more)` : '';
  const ageHint = ageHours < 1
    ? `${Math.round(ageHours * 60)}m ago`
    : `${ageHours.toFixed(1)}h ago`;
  const warning = `[artibot:test-status] ${failed} failing test(s) recorded ${ageHint}`
    + ` — ${sample}${extra}`;

  return { exists: true, stale, ageHours, summary, warning };
}
