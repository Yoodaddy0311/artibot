#!/usr/bin/env node
/**
 * Nightly Adaptive Effort/Budget Policy Trainer (P3, L3 learning).
 *
 * Reads the last N days of Artibot reward episodes (carrying the additive
 * `effort` / `command` / `budget` / `tokensUsed` meta fields recorded by
 * {@link module:lib/learning/grpo/reward-metrics}), then refreshes the learned
 * effort/budget overlay via `effort-policy-updater.trainFromEpisodes`.
 *
 * The overlay is consumed (read-only) by the L4 reader
 * {@link module:lib/cognitive/effort-policy-config}, which is DORMANT by default
 * (enabled:false). This trainer therefore runs in shadow mode: it may refresh
 * the policy snapshot at night, but nothing reads it until an operator flips the
 * reader flag (S2). Cold-start guard inside the updater means fewer than
 * `coldStartEpisodes` usable episodes => no disk write at all.
 *
 * Mirrors `nightly-skill-policy-trainer.mjs` so operators keep a single mental
 * model across all policy training jobs. Never throws on expected failures;
 * emits a structured descriptor for the ledger + tests.
 *
 * Flags:
 *   --dry-run              Evaluate but do not persist.
 *   --window-days <N>      Episode lookback window (default 30).
 *   --policy-path <path>   Override `~/.claude/artibot/policies/effort-policy-v1.json`.
 *   --episodes <path>      Override episode source JSON (test / migration).
 *   --help                 Print usage and exit.
 *
 * Ledger: `plugins/artibot/runtime/effort-policy-trail.json` (append-only JSON array).
 *
 * Zero external network IO. Deterministic under NODE_ENV=test.
 *
 * @module scripts/hooks/nightly-effort-policy-trainer
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEffortPolicyUpdater,
  EFFORT_TRAINER_DEFAULTS,
  resolveEffortPolicyPaths,
} from '../../lib/learning/grpo/effort-policy-updater.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../../lib/core/file.js';
import { getPluginRoot } from '../../lib/core/platform.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments.
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
  'Usage: node scripts/hooks/nightly-effort-policy-trainer.mjs [options]',
  '',
  'Options:',
  '  --dry-run              Evaluate without writing policy',
  '  --window-days <N>      Lookback window in days (default 30)',
  '  --policy-path <path>   Override policy file path',
  '  --episodes <path>      Override episode source JSON',
  '  -h, --help             Show this message',
].join('\n');

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Resolve the effort-policy trail path (sibling to the skill/joint trails).
 * @returns {string}
 */
export function resolveTrailPath() {
  return path.resolve(__dirname, '..', '..', 'runtime', 'effort-policy-trail.json');
}

/**
 * Append one entry to the effort-policy trail (append-only JSON array).
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

// ---------------------------------------------------------------------------
// Episode source
// ---------------------------------------------------------------------------

/**
 * Resolve the default reward-metrics source (`runtime/reward-metrics.json`).
 * @returns {string}
 */
export function resolveMetricsPath() {
  return path.join(getPluginRoot(), 'runtime', 'reward-metrics.json');
}

/**
 * Read episodes from a JSON file. Accepts either a bare episode array or a
 * reward-metrics state object with a `recentEpisodes` array. Returns `[]` on
 * missing/malformed input — never throws.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
export async function readEpisodesFile(filePath) {
  const data = await readJsonFile(filePath);
  const arr = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray(data.recentEpisodes))
      ? data.recentEpisodes
      : [];
  return arr.filter((e) => e && typeof e === 'object');
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
 * Keep only episodes whose timestamp falls within the lookback window. Entries
 * without a parseable timestamp are retained (fixture-friendly).
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

/**
 * Keep only episodes usable for effort/budget training: they must carry a
 * finite reward (the updater rolls up per-command / per-effort signal off the
 * additive `command` / `effort` / `tokensUsed` meta fields).
 *
 * @param {object[]} episodes
 * @returns {object[]}
 */
export function filterEffortEligible(episodes) {
  return (episodes ?? []).filter((e) => {
    if (!e || typeof e !== 'object') return false;
    return typeof e.reward === 'number' && Number.isFinite(e.reward);
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the nightly effort-policy trainer once. Never throws on expected
 * failures; emits a structured result for the ledger + tests. Cold-start /
 * coldStartEpisodes gating is delegated to the updater, which performs no disk
 * write when there are too few usable episodes.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.windowDays]
 * @param {string} [opts.policyPath]
 * @param {string} [opts.episodesPath]
 * @param {object[]} [opts.episodes]
 * @param {object} [opts.config]
 * @param {string} [opts.trailPath]
 * @param {number} [opts.nowMs]
 * @param {() => Date} [opts.now] - injectable clock forwarded to the updater
 * @param {{ info: Function, warn: Function, error: Function }} [opts.logger]
 * @returns {Promise<{
 *   status: 'trained'|'skipped'|'dry-run',
 *   metrics?: object,
 *   policy?: object|null,
 *   episodesUsed?: number,
 *   reason?: string,
 * }>}
 */
export async function runNightlyEffortTrainer(opts = {}) {
  const logger = opts.logger ?? {
    info: (m) => process.stderr.write(`[effort-trainer] ${m}\n`),
    warn: (m) => process.stderr.write(`[effort-trainer] WARN ${m}\n`),
    error: (m) => process.stderr.write(`[effort-trainer] ERROR ${m}\n`),
  };
  const config = { ...EFFORT_TRAINER_DEFAULTS, ...(opts.config ?? {}) };
  const nowMs = opts.nowMs ?? Date.now();

  // 1. Collect episodes. Explicit injection wins; otherwise fall back to the
  //    reward-metrics recentEpisodes trail (default nightly source).
  let episodes = opts.episodes;
  if (!episodes) {
    const source = opts.episodesPath ?? resolveMetricsPath();
    episodes = await readEpisodesFile(source);
  }
  episodes = Array.isArray(episodes) ? episodes : [];
  const windowed = filterByWindow(episodes, opts.windowDays ?? 30, nowMs);
  const usable = filterEffortEligible(windowed);

  const updater = createEffortPolicyUpdater({
    policyPath: opts.policyPath,
    config,
    logger,
    ...(typeof opts.now === 'function' ? { now: opts.now } : {}),
  });

  if (opts.dryRun) {
    const prev = await updater.loadPolicy();
    const summary = summarizeEpisodes(usable, prev);
    await appendTrail(
      { action: 'dry-run', metrics: summary, count: usable.length },
      opts.trailPath,
    );
    return { status: 'dry-run', metrics: summary, episodesUsed: usable.length };
  }

  // 2. Train. The updater applies the cold-start guard internally and returns
  //    `skipped:true` (no disk write) when usable < coldStartEpisodes.
  const out = await updater.trainFromEpisodes(usable);

  if (out?.skipped) {
    await appendTrail(
      {
        action: 'skipped',
        reason: 'cold-start',
        count: out.episodesUsed ?? usable.length,
        coldStartEpisodes: config.coldStartEpisodes,
      },
      opts.trailPath,
    );
    logger.info(
      `effort-policy cold-start deferred: ${out.episodesUsed ?? usable.length} < ${config.coldStartEpisodes}`,
    );
    return {
      status: 'skipped',
      reason: 'cold-start',
      policy: out.policy ?? null,
      episodesUsed: out.episodesUsed ?? usable.length,
    };
  }

  await appendTrail(
    {
      action: 'trained',
      snapshotId: out?.policy?.snapshotId ?? null,
      count: out?.episodesUsed ?? usable.length,
      coldStart: out?.coldStart ?? false,
    },
    opts.trailPath,
  );

  logger.info(
    `trained effort policy: used=${out?.episodesUsed ?? 0} bands=${Object.keys(out?.overlay?.bandShifts ?? {}).length} mults=${Object.keys(out?.overlay?.budgetMultipliers ?? {}).length}`,
  );

  return {
    status: 'trained',
    metrics: out?.overlay ?? {},
    policy: out?.policy ?? null,
    episodesUsed: out?.episodesUsed ?? usable.length,
  };
}

/**
 * Dry-run summary — counts per-command and per-effort occurrences and notes
 * which commands are already in the current overlay. Pure; no disk IO.
 *
 * @param {object[]} episodes
 * @param {object|null} prevPolicy
 * @returns {{
 *   commands: Record<string, { count: number, known: boolean }>,
 *   efforts: Record<string, number>,
 *   uniqueCommands: number,
 *   totalEpisodes: number,
 * }}
 */
export function summarizeEpisodes(episodes, prevPolicy) {
  const known = new Set(Object.keys(prevPolicy?.bandShifts ?? {}));
  const commands = {};
  const efforts = {};
  for (const ep of episodes ?? []) {
    if (!ep || typeof ep !== 'object') continue;
    if (typeof ep.command === 'string' && ep.command) {
      if (!commands[ep.command]) commands[ep.command] = { count: 0, known: known.has(ep.command) };
      commands[ep.command].count++;
    }
    if (typeof ep.effort === 'string' && ep.effort) {
      efforts[ep.effort] = (efforts[ep.effort] ?? 0) + 1;
    }
  }
  return {
    commands,
    efforts,
    uniqueCommands: Object.keys(commands).length,
    totalEpisodes: episodes?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Direct invocation
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
  runNightlyEffortTrainer({
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
      process.stderr.write(`[effort-trainer] FATAL ${err?.message ?? err}\n`);
      process.exit(1);
    });
}

// Exported for tests that need a direct path handle.
export { resolveEffortPolicyPaths };
