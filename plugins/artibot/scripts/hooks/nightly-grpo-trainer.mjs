#!/usr/bin/env node
/**
 * Nightly GRPO Policy Trainer.
 *
 * Scheduled runner that trains the routing policy from the last N days of
 * episodes, appends an audit ledger entry, enforces KL-rejection / auto-
 * rollback guards, and persists the updated theta + snapshot.
 *
 * Flags:
 *   --dry-run              Train + evaluate but do not persist.
 *   --force-cold-start     Ignore existing policy and re-run warmup.
 *   --window-days <N>      Episode lookback window (default 30).
 *   --policy-path <path>   Override `~/.claude/artibot/policies/routing-policy-v1.json`.
 *   --episodes <path>      Override episode source JSON (test / migration).
 *   --help                 Print usage and exit.
 *
 * Ledger (append-only): `plugins/artibot/runtime/routing-policy-trail.json`.
 *   Each entry: { ts, action, metrics, snapshotId, note }.
 *
 * Auto-rollback triggers (Appendix C / §4.4 of the design doc):
 *   - accuracyVsHeuristic < 0.5 for `rollbackConsecutiveNights` consecutive
 *     nights -> rollback to snapshot index `rollbackConsecutiveNights`.
 *   - klFromPrev > klRejectThreshold -> reject update (keep previous theta).
 *
 * Zero external network IO. Deterministic under NODE_ENV=test.
 *
 * @module scripts/hooks/nightly-grpo-trainer
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createPolicyUpdater,
  DEFAULTS,
  resolvePolicyPaths,
} from '../../lib/learning/grpo/policy-updater.js';
import { readJsonFile, writeJsonFile, ensureDir } from '../../lib/core/file.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments into a normalized options object.
 *
 * @param {string[]} argv
 * @returns {{
 *   dryRun: boolean,
 *   forceColdStart: boolean,
 *   windowDays: number,
 *   policyPath: string|null,
 *   episodesPath: string|null,
 *   help: boolean,
 * }}
 */
export function parseArgs(argv) {
  const out = {
    dryRun: false,
    forceColdStart: false,
    windowDays: 30,
    policyPath: null,
    episodesPath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--force-cold-start':
        out.forceColdStart = true;
        break;
      case '--window-days': {
        const v = Number(argv[++i]);
        if (Number.isFinite(v) && v > 0) out.windowDays = Math.floor(v);
        break;
      }
      case '--policy-path':
        out.policyPath = argv[++i] ?? null;
        break;
      case '--episodes':
        out.episodesPath = argv[++i] ?? null;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        // ignore unknowns
        break;
    }
  }
  return out;
}

export const USAGE = [
  'Usage: node scripts/hooks/nightly-grpo-trainer.mjs [options]',
  '',
  'Options:',
  '  --dry-run              Compute + evaluate, skip persistence',
  '  --force-cold-start     Rebuild policy from heuristic warmup',
  '  --window-days <N>      Lookback window in days (default 30)',
  '  --policy-path <path>   Override policy file path',
  '  --episodes <path>      Override episode source JSON',
  '  -h, --help             Show this message',
].join('\n');

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Resolve the routing-policy audit trail path. Kept inside the plugin's
 * `runtime/` dir so it ships alongside the other local trail files.
 *
 * @returns {string} absolute path
 */
export function resolveTrailPath() {
  return path.resolve(__dirname, '..', '..', 'runtime', 'routing-policy-trail.json');
}

/**
 * Append one entry to the policy trail (append-only JSON array).
 *
 * @param {object} entry
 * @param {string} [trailPath]
 * @returns {Promise<void>}
 */
export async function appendTrail(entry, trailPath) {
  const file = trailPath ?? resolveTrailPath();
  await ensureDir(path.dirname(file));
  const current = (await readJsonFile(file)) ?? [];
  const arr = Array.isArray(current) ? current : [];
  arr.push({ ts: new Date().toISOString(), ...entry });
  await writeJsonFile(file, arr);
}

/**
 * Load the trail for consecutive-failure detection.
 *
 * @param {string} [trailPath]
 * @returns {Promise<object[]>}
 */
export async function loadTrail(trailPath) {
  const file = trailPath ?? resolveTrailPath();
  const data = await readJsonFile(file);
  return Array.isArray(data) ? data : [];
}

/**
 * Check whether the last `n` successful training entries all report
 * accuracyVsHeuristic below `threshold`. Returns true if rollback is warranted.
 *
 * @param {object[]} trail
 * @param {number} n
 * @param {number} threshold
 * @returns {boolean}
 */
export function shouldAutoRollback(trail, n, threshold) {
  const trained = trail.filter((e) => e.action === 'trained').slice(-n);
  if (trained.length < n) return false;
  return trained.every((e) => typeof e.metrics?.accuracyVsHeuristic === 'number'
    && e.metrics.accuracyVsHeuristic < threshold);
}

// ---------------------------------------------------------------------------
// Episode source
// ---------------------------------------------------------------------------

/**
 * Read episodes from a JSON array file. Returns `[]` when missing/malformed.
 * Non-object entries are filtered out.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
export async function readEpisodesFile(filePath) {
  const data = await readJsonFile(filePath);
  if (!Array.isArray(data)) return [];
  return data.filter((e) => e && typeof e === 'object');
}

/**
 * Filter episodes by timestamp window. Entries with missing/invalid ts are
 * retained (best-effort for fixture inputs).
 *
 * @param {object[]} episodes
 * @param {number} windowDays
 * @param {number} [nowMs=Date.now()]
 * @returns {object[]}
 */
export function filterByWindow(episodes, windowDays, nowMs = Date.now()) {
  if (!Number.isFinite(windowDays) || windowDays <= 0) return episodes;
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
  return episodes.filter((e) => {
    const ts = parseTs(e.timestamp ?? e.ts ?? e.time);
    if (ts === null) return true;
    return ts >= cutoff;
  });
}

function parseTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run the nightly trainer once. Returns a result descriptor suitable for
 * logging and tests. Never throws on expected failures (missing episodes,
 * malformed policy) — instead emits `{ status: 'skipped'|'rejected'|... }`.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.forceColdStart]
 * @param {number} [opts.windowDays]
 * @param {string} [opts.policyPath]
 * @param {string} [opts.episodesPath]
 * @param {object[]} [opts.episodes]         // direct injection (tests)
 * @param {object} [opts.config]             // routing-policy config block
 * @param {string} [opts.trailPath]          // trail file override (tests)
 * @param {number} [opts.nowMs]              // frozen clock (tests)
 * @param {{ info: Function, warn: Function, error: Function }} [opts.logger]
 * @returns {Promise<{
 *   status: 'trained'|'skipped'|'rejected'|'rolled-back'|'cold-start-deferred'|'dry-run',
 *   metrics?: object,
 *   policy?: object,
 *   rolledBackTo?: string,
 *   episodesUsed?: number,
 *   reason?: string,
 * }>}
 */
export async function runNightlyTrainer(opts = {}) {
  const logger = opts.logger ?? {
    info: (m) => process.stderr.write(`[grpo-trainer] ${m}\n`),
    warn: (m) => process.stderr.write(`[grpo-trainer] WARN ${m}\n`),
    error: (m) => process.stderr.write(`[grpo-trainer] ERROR ${m}\n`),
  };
  const config = { ...DEFAULTS, ...(opts.config ?? {}) };
  const nowMs = opts.nowMs ?? Date.now();

  // 1. Collect episodes
  let episodes = opts.episodes;
  if (!episodes && opts.episodesPath) {
    episodes = await readEpisodesFile(opts.episodesPath);
  }
  episodes = Array.isArray(episodes) ? episodes : [];
  const windowed = filterByWindow(episodes, opts.windowDays ?? 30, nowMs);

  if (windowed.length === 0) {
    const entry = { action: 'skipped', reason: 'no-episodes', count: 0 };
    await appendTrail(entry, opts.trailPath);
    logger.info('no episodes available; skipping training');
    return { status: 'skipped', reason: 'no-episodes', episodesUsed: 0 };
  }

  // 2. Auto-rollback precheck
  const trail = await loadTrail(opts.trailPath);
  if (shouldAutoRollback(trail, config.rollbackConsecutiveNights, config.accuracyRollbackThreshold)) {
    const updater = createPolicyUpdater({ policyPath: opts.policyPath, config, logger });
    const result = await updater.rollback(config.rollbackConsecutiveNights);
    if (result) {
      await appendTrail({
        action: 'rolled-back',
        reason: 'consecutive-accuracy-below-threshold',
        rolledBackTo: result.rolledBackTo,
      }, opts.trailPath);
      logger.warn(`auto-rollback triggered -> ${result.rolledBackTo}`);
      return { status: 'rolled-back', rolledBackTo: result.rolledBackTo };
    }
  }

  // 3. Force cold-start by wiping policy path (controlled by caller)
  if (opts.forceColdStart) {
    const { policyFile } = resolvePolicyPaths(opts.policyPath);
    try {
      await fs.unlink(policyFile);
    } catch {
      // missing is fine
    }
  }

  // 4. Dry-run: evaluate only (no persistence, no trail spam)
  if (opts.dryRun) {
    const updater = createPolicyUpdater({ policyPath: opts.policyPath, config, logger });
    const prev = await updater.loadPolicy();
    if (!prev && windowed.length < config.coldStartEpisodes) {
      return {
        status: 'cold-start-deferred',
        reason: 'insufficient-episodes',
        episodesUsed: windowed.length,
      };
    }
    // reuse trainFromEpisodes but avoid writes — simulate via in-memory config
    const res = await simulateTrain(windowed, prev, config);
    await appendTrail({ action: 'dry-run', metrics: res.metrics, count: windowed.length }, opts.trailPath);
    return { status: 'dry-run', metrics: res.metrics, episodesUsed: windowed.length };
  }

  // 5. Real training via facade
  const updater = createPolicyUpdater({ policyPath: opts.policyPath, config, logger });
  const out = await updater.trainFromEpisodes(windowed);

  if (!out.policy) {
    await appendTrail({
      action: 'cold-start-deferred',
      reason: out.metrics?.reason ?? 'unknown',
      count: windowed.length,
      required: config.coldStartEpisodes,
    }, opts.trailPath);
    logger.info(`cold-start deferred: have ${windowed.length}, need ${config.coldStartEpisodes}`);
    return {
      status: 'cold-start-deferred',
      reason: out.metrics?.reason ?? 'unknown',
      episodesUsed: windowed.length,
    };
  }

  if (out.rejected) {
    await appendTrail({
      action: 'rejected',
      reason: out.rejected,
      metrics: out.metrics,
      count: windowed.length,
    }, opts.trailPath);
    logger.warn(`update rejected: ${out.rejected}`);
    return {
      status: 'rejected',
      reason: out.rejected,
      metrics: out.metrics,
      episodesUsed: windowed.length,
    };
  }

  await appendTrail({
    action: 'trained',
    metrics: out.metrics,
    snapshotId: out.policy.snapshotId,
    count: windowed.length,
    coldStart: Boolean(out.coldStart),
  }, opts.trailPath);

  logger.info(
    `trained policy: logLoss=${out.metrics.logLoss.toFixed(4)} acc=${out.metrics.accuracyVsHeuristic.toFixed(3)} kl=${out.metrics.klFromPrev.toFixed(4)}`,
  );

  return {
    status: 'trained',
    metrics: out.metrics,
    policy: out.policy,
    episodesUsed: windowed.length,
  };
}

/**
 * Pure in-memory evaluation for `--dry-run`. Runs the same pipeline as
 * `trainFromEpisodes` but never touches disk.
 *
 * @param {object[]} episodes
 * @param {object|null} prev
 * @param {object} config
 * @returns {Promise<{ theta: number[], metrics: object }>}
 */
async function simulateTrain(episodes, prev, config) {
  const mod = await import('../../lib/learning/grpo/policy-updater.js');
  const {
    coldStartWarmup: warmup,
    trainBatch,
    evaluatePolicy,
    FEATURE_DIM: DIM,
  } = mod;

  if (!prev) {
    const w = warmup(episodes, {
      minEpisodes: config.coldStartEpisodes,
      iterations: config.warmupIterations,
      learningRate: config.warmupLearningRate,
    });
    if (!w) return { theta: new Array(DIM).fill(0), metrics: { reason: 'cold-start-insufficient' } };
    const metrics = evaluatePolicy(w.theta, episodes);
    return { theta: w.theta, metrics };
  }

  const res = trainBatch(episodes, prev.theta, {
    learningRate: config.learningRate,
    klPenalty: config.klPenalty,
  });
  const metrics = evaluatePolicy(res.theta, episodes, prev.theta);
  return { theta: res.theta, metrics };
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
  runNightlyTrainer({
    dryRun: args.dryRun,
    forceColdStart: args.forceColdStart,
    windowDays: args.windowDays,
    policyPath: args.policyPath,
    episodesPath: args.episodesPath,
  })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`[grpo-trainer] FATAL ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
