#!/usr/bin/env node
/**
 * Nightly session rollup hook.
 *
 * Scheduled at `30 4 * * *` (04:30 daily). Invokes the session aggregator to:
 *   1. Roll up yesterday's sessions into a daily bucket
 *   2. Prune session originals older than the retention window (default 30d)
 *
 * Never throws on expected failures — returns a structured status object so
 * cron wrappers can log it. Zero external network IO.
 *
 * Flags:
 *   --dry-run               Compute only, skip writes
 *   --window-days <N>       Retention window in days (default 30)
 *   --date <YYYY-MM-DD>     Target date to rollup (default: yesterday UTC)
 *   --storage-path <path>   Override aggregator storage root (tests)
 *   --help                  Print usage
 *
 * @module scripts/hooks/nightly-session-rollup
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSessionAggregator,
  dayKey,
} from '../../lib/observability/session-aggregator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI args into a normalized options object.
 *
 * @param {string[]} argv
 * @returns {{
 *   dryRun: boolean,
 *   windowDays: number,
 *   date: string|null,
 *   storagePath: string|null,
 *   help: boolean,
 * }}
 */
export function parseArgs(argv) {
  const out = {
    dryRun: false,
    windowDays: 30,
    date: null,
    storagePath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--window-days': {
        const v = Number(argv[++i]);
        if (Number.isFinite(v) && v > 0) out.windowDays = Math.floor(v);
        break;
      }
      case '--date':
        out.date = argv[++i] ?? null;
        break;
      case '--storage-path':
        out.storagePath = argv[++i] ?? null;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        // ignore unknowns (forward compat)
        break;
    }
  }
  return out;
}

export const USAGE = [
  'Usage: node scripts/hooks/nightly-session-rollup.mjs [options]',
  '',
  'Options:',
  '  --dry-run               Compute without writing rollups or archiving',
  '  --window-days <N>       Retention window in days (default 30)',
  '  --date <YYYY-MM-DD>     Target date to roll up (default: yesterday UTC)',
  '  --storage-path <path>   Override aggregator storage root',
  '  -h, --help              Show this message',
].join('\n');

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the default storage root for session records. Lives under the
 * plugin's `runtime/observability/` so it ships alongside other trail files.
 *
 * @returns {string}
 */
export function resolveDefaultStoragePath() {
  return path.resolve(__dirname, '..', '..', 'runtime', 'observability');
}

/**
 * Compute yesterday's UTC day key relative to `nowMs`.
 *
 * @param {number} [nowMs]
 * @returns {string}
 */
export function yesterdayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  const y = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  return dayKey(y);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the nightly rollup once. Never throws on expected failures.
 *
 * @param {{
 *   dryRun?: boolean,
 *   windowDays?: number,
 *   date?: string|null,
 *   storagePath?: string|null,
 *   aggregator?: object,
 *   nowMs?: number,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 * }} [opts]
 * @returns {Promise<{
 *   status: 'completed' | 'dry-run' | 'failed',
 *   date: string,
 *   rolledUp?: { day: string, sessionCount: number } | null,
 *   pruned?: { archived: number, kept: number } | null,
 *   reason?: string,
 * }>}
 */
export async function runNightlyRollup(opts = {}) {
  const logger = opts.logger ?? {
    info: (m) => process.stderr.write(`[session-rollup] ${m}\n`),
    warn: (m) => process.stderr.write(`[session-rollup] WARN ${m}\n`),
    error: (m) => process.stderr.write(`[session-rollup] ERROR ${m}\n`),
  };
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const windowDays = Number.isFinite(opts.windowDays) && opts.windowDays > 0
    ? Math.floor(opts.windowDays)
    : 30;
  const targetDate = opts.date || yesterdayKey(nowMs);
  const storagePath = opts.storagePath || resolveDefaultStoragePath();

  const aggregator = opts.aggregator
    || createSessionAggregator({ storagePath, windowDays, now: () => nowMs });

  try {
    if (opts.dryRun) {
      const existing = await aggregator.getRollups({ since: targetDate, limit: 5 });
      logger.info?.(`dry-run: ${existing.length} recent rollups found for ${targetDate}+`);
      return {
        status: 'dry-run',
        date: targetDate,
        rolledUp: null,
        pruned: null,
      };
    }

    const rolledUp = await aggregator.rollupDaily(targetDate);
    const pruned = await aggregator.pruneOlder(windowDays);

    logger.info?.(
      `rollup ${targetDate} sessions=${rolledUp?.sessionCount ?? 0} archived=${pruned.archived} kept=${pruned.kept}`,
    );

    return {
      status: 'completed',
      date: targetDate,
      rolledUp: rolledUp
        ? { day: rolledUp.day, sessionCount: rolledUp.sessionCount }
        : null,
      pruned,
    };
  } catch (err) {
    logger.error?.(`rollup failed: ${err?.message ?? err}`);
    return {
      status: 'failed',
      date: targetDate,
      reason: String(err?.message ?? err),
    };
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const invokedDirect = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  } catch {
    return false;
  }
})();

if (invokedDirect) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  runNightlyRollup({
    dryRun: args.dryRun,
    windowDays: args.windowDays,
    date: args.date,
    storagePath: args.storagePath,
  })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      process.exit(res.status === 'failed' ? 1 : 0);
    })
    .catch((err) => {
      process.stderr.write(`[session-rollup] FATAL ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
