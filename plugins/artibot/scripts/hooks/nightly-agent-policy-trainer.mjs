#!/usr/bin/env node
/**
 * Nightly Agent-Policy Trainer.
 *
 * Scheduled runner that trains the agent-selection softmax policy (v3.5 §5.4)
 * from the last N days of agent-selection episodes. Mirrors the Phase B
 * routing trainer's structure: append-only audit ledger, KL-rejection guard,
 * auto-rollback, dry-run mode.
 *
 * Flags:
 *   --dry-run              Train + evaluate but do not persist.
 *   --window-days <N>      Episode lookback window (default 30).
 *   --policy-path <path>   Override `~/.claude/artibot/policies/agent-policy-v1.json`.
 *   --episodes <path>      Override episode source JSON (tests / migration).
 *   --help                 Print usage and exit.
 *
 * Ledger (append-only): `plugins/artibot/runtime/agent-policy-trail.json`.
 *
 * Auto-rollback triggers:
 *   - accuracyVsBaseline < 0.5 for `rollbackConsecutiveNights` consecutive
 *     nights -> rollback to snapshot at that depth.
 *   - klFromPrev > klRejectThreshold -> reject update (keep previous weights).
 *
 * Zero external network IO. Deterministic under NODE_ENV=test.
 *
 * @module scripts/hooks/nightly-agent-policy-trainer
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentPolicy,
  DEFAULTS,
} from '../../lib/learning/grpo/agent-policy.js';
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
 *   windowDays: number,
 *   policyPath: string|null,
 *   episodesPath: string|null,
 *   help: boolean,
 * }}
 */
export function parseArgs(argv) {
  const out = {
    dryRun: false,
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
        break;
    }
  }
  return out;
}

export const USAGE = [
  'Usage: node scripts/hooks/nightly-agent-policy-trainer.mjs [options]',
  '',
  'Options:',
  '  --dry-run              Compute + evaluate, skip persistence',
  '  --window-days <N>      Lookback window in days (default 30)',
  '  --policy-path <path>   Override policy file path',
  '  --episodes <path>      Override episode source JSON',
  '  -h, --help             Show this message',
].join('\n');

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Resolve the agent-policy audit trail path.
 *
 * @returns {string}
 */
export function resolveTrailPath() {
  return path.resolve(__dirname, '..', '..', 'runtime', 'agent-policy-trail.json');
}

/**
 * Append one entry to the agent-policy trail (append-only JSON array).
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
 * Check whether the last `n` "trained" entries all report
 * accuracyVsBaseline below `threshold`. Returns true if rollback is warranted.
 *
 * @param {object[]} trail
 * @param {number} n
 * @param {number} threshold
 * @returns {boolean}
 */
export function shouldAutoRollback(trail, n, threshold) {
  const trained = trail.filter((e) => e.action === 'trained').slice(-n);
  if (trained.length < n) return false;
  return trained.every((e) => typeof e.metrics?.accuracyVsBaseline === 'number'
    && e.metrics.accuracyVsBaseline < threshold);
}

// ---------------------------------------------------------------------------
// Episode source
// ---------------------------------------------------------------------------

/**
 * Read episodes from a JSON array file. Returns `[]` when missing/malformed.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
export async function readEpisodesFile(filePath) {
  const data = await readJsonFile(filePath);
  if (!Array.isArray(data)) return [];
  return data.filter((e) => e && typeof e === 'object');
}

function parseTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Filter episodes by timestamp window. Entries with missing/invalid ts are
 * retained (best-effort for fixture inputs).
 *
 * @param {object[]} episodes
 * @param {number} windowDays
 * @param {number} [nowMs]
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

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run the nightly agent-policy trainer once. Never throws on expected
 * failures (missing episodes, malformed policy) — returns a status descriptor
 * for logs and tests.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.windowDays]
 * @param {string} [opts.policyPath]
 * @param {string} [opts.episodesPath]
 * @param {object[]} [opts.episodes]
 * @param {object} [opts.config]             // agent-policy config block
 * @param {object} [opts.baseConfig]         // full artibot config (baseline fallback)
 * @param {string} [opts.trailPath]
 * @param {number} [opts.nowMs]
 * @param {{ info: Function, warn: Function, error: Function }} [opts.logger]
 * @returns {Promise<{
 *   status: 'trained'|'skipped'|'rejected'|'rolled-back'|'dry-run'|'no-trainable',
 *   metrics?: object,
 *   policy?: object,
 *   rolledBackTo?: string,
 *   episodesUsed?: number,
 *   reason?: string,
 * }>}
 */
export async function runNightlyAgentTrainer(opts = {}) {
  const logger = opts.logger ?? {
    info: (m) => process.stderr.write(`[agent-trainer] ${m}\n`),
    warn: (m) => process.stderr.write(`[agent-trainer] WARN ${m}\n`),
    error: (m) => process.stderr.write(`[agent-trainer] ERROR ${m}\n`),
  };
  const config = { ...DEFAULTS, ...(opts.config ?? {}) };
  const rollbackN = opts.config?.rollbackConsecutiveNights ?? 3;
  const accRollback = opts.config?.accuracyRollbackThreshold ?? 0.5;
  const nowMs = opts.nowMs ?? Date.now();

  // 1. Collect episodes
  let episodes = opts.episodes;
  if (!episodes && opts.episodesPath) {
    episodes = await readEpisodesFile(opts.episodesPath);
  }
  episodes = Array.isArray(episodes) ? episodes : [];
  const windowed = filterByWindow(episodes, opts.windowDays ?? 30, nowMs);

  if (windowed.length === 0) {
    await appendTrail({ action: 'skipped', reason: 'no-episodes', count: 0 }, opts.trailPath);
    logger.info('no episodes available; skipping training');
    return { status: 'skipped', reason: 'no-episodes', episodesUsed: 0 };
  }

  // 2. Auto-rollback precheck
  const trail = await loadTrail(opts.trailPath);
  if (shouldAutoRollback(trail, rollbackN, accRollback)) {
    const policy = createAgentPolicy({
      policyPath: opts.policyPath,
      config,
      baseConfig: opts.baseConfig,
      logger,
    });
    const result = await policy.rollback(rollbackN);
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

  // 3. Dry-run path: simulate training in-memory.
  if (opts.dryRun) {
    const sim = await simulateTrain(windowed, opts.policyPath, config);
    await appendTrail({
      action: 'dry-run',
      metrics: sim.metrics,
      count: windowed.length,
    }, opts.trailPath);
    return { status: 'dry-run', metrics: sim.metrics, episodesUsed: windowed.length };
  }

  // 4. Real training via facade
  const policy = createAgentPolicy({
    policyPath: opts.policyPath,
    config,
    baseConfig: opts.baseConfig,
    logger,
  });
  const out = await policy.trainFromEpisodes(windowed);

  if (!out.policy || out.metrics?.reason === 'no-trainable-episodes') {
    await appendTrail({
      action: 'no-trainable',
      reason: out.metrics?.reason ?? 'unknown',
      count: windowed.length,
    }, opts.trailPath);
    logger.info('no trainable episodes (all exploration or malformed)');
    return {
      status: 'no-trainable',
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
    familiesTouched: out.familiesTouched ?? 0,
  }, opts.trailPath);

  logger.info(
    `trained agent policy: logLoss=${(out.metrics.logLoss ?? 0).toFixed(4)} acc=${(out.metrics.accuracyVsBaseline ?? 0).toFixed(3)} kl=${(out.metrics.klFromPrev ?? 0).toFixed(4)}`,
  );

  return {
    status: 'trained',
    metrics: out.metrics,
    policy: out.policy,
    episodesUsed: windowed.length,
  };
}

/**
 * Pure in-memory evaluation for `--dry-run`.
 *
 * @param {object[]} episodes
 * @param {string|undefined} policyPath
 * @param {object} config
 * @returns {Promise<{ metrics: object }>}
 */
async function simulateTrain(episodes, policyPath, config) {
  const mod = await import('../../lib/learning/grpo/agent-policy.js');
  const { loadPolicy, updatePolicy, evaluatePolicy } = mod;
  const prev = await loadPolicy(policyPath);
  const prevWeights = prev?.weights ?? {};
  const upd = updatePolicy(episodes, prevWeights, {
    learningRate: config.learningRate,
    klPenalty: config.klPenalty,
    temperature: config.temperature,
    clipRange: config.clipRange,
  });
  const metrics = evaluatePolicy(upd.weights, episodes, prevWeights, {
    temperature: config.temperature,
  });
  return { metrics };
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
  runNightlyAgentTrainer({
    dryRun: args.dryRun,
    windowDays: args.windowDays,
    policyPath: args.policyPath,
    episodesPath: args.episodesPath,
  })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`[agent-trainer] FATAL ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
