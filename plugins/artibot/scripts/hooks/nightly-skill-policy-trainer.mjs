#!/usr/bin/env node
/**
 * Nightly Skill-Trigger Policy Trainer (GRPO v3.5 §5.5).
 *
 * Reads the last N days of Artibot episodes, filters those with `skillsUsed`
 * populated, trains the per-skill trigger policy via `skill-policy.updatePolicy`,
 * appends an audit ledger entry, and persists an atomic snapshot.
 *
 * Mirrors `nightly-grpo-trainer.mjs` so operators have a single mental model
 * for both routing and skill-trigger training jobs.
 *
 * Flags:
 *   --dry-run              Train + evaluate but do not persist.
 *   --window-days <N>      Episode lookback window (default 30).
 *   --policy-path <path>   Override `~/.claude/artibot/policies/skill-policy-v1.json`.
 *   --episodes <path>      Override episode source JSON (test / migration).
 *   --help                 Print usage and exit.
 *
 * Ledger: `plugins/artibot/runtime/skill-policy-trail.json` (append-only JSON array).
 *
 * Zero external network IO. Deterministic under NODE_ENV=test.
 *
 * @module scripts/hooks/nightly-skill-policy-trainer
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSkillPolicy,
  DEFAULTS,
  resolvePolicyPaths,
} from '../../lib/learning/grpo/skill-policy.js';
import { readJsonFile, writeJsonFile, ensureDir } from '../../lib/core/file.js';

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
  'Usage: node scripts/hooks/nightly-skill-policy-trainer.mjs [options]',
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
 * Resolve the skill-policy trail path (sibling to the routing-policy trail).
 * @returns {string}
 */
export function resolveTrailPath() {
  return path.resolve(__dirname, '..', '..', 'runtime', 'skill-policy-trail.json');
}

/**
 * Append one entry to the skill-policy trail.
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
 * Read episodes array from a JSON file. Returns `[]` on missing/malformed input.
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
 * Keep only episodes that actually fired at least one skill — otherwise they
 * cannot contribute gradient for any skill entry.
 *
 * @param {object[]} episodes
 * @returns {object[]}
 */
export function filterWithSkills(episodes) {
  return (episodes ?? []).filter((e) => {
    if (!e || typeof e !== 'object') return false;
    if (!Array.isArray(e.skillsUsed) || e.skillsUsed.length === 0) return false;
    return typeof e.reward === 'number' && Number.isFinite(e.reward);
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the nightly skill-policy trainer once. Never throws on expected
 * failures; emits a structured result for the ledger + tests.
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
 * @param {{ info: Function, warn: Function, error: Function }} [opts.logger]
 * @returns {Promise<{
 *   status: 'trained'|'skipped'|'dry-run',
 *   metrics?: object,
 *   policy?: object,
 *   episodesUsed?: number,
 *   reason?: string,
 * }>}
 */
export async function runNightlySkillTrainer(opts = {}) {
  const logger = opts.logger ?? {
    info: (m) => process.stderr.write(`[skill-trainer] ${m}\n`),
    warn: (m) => process.stderr.write(`[skill-trainer] WARN ${m}\n`),
    error: (m) => process.stderr.write(`[skill-trainer] ERROR ${m}\n`),
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
  const usable = filterWithSkills(windowed);

  if (usable.length === 0) {
    await appendTrail({ action: 'skipped', reason: 'no-skill-episodes', count: 0 }, opts.trailPath);
    logger.info('no skill-bearing episodes; skipping training');
    return { status: 'skipped', reason: 'no-skill-episodes', episodesUsed: 0 };
  }

  if (opts.dryRun) {
    // Build a transient policy to inspect metrics without writing.
    const facade = createSkillPolicy({ policyPath: opts.policyPath, config, logger });
    const prev = (await facade.loadPolicy()) ?? { skills: {} };
    const summary = summarizeEpisodes(usable, prev);
    await appendTrail({
      action: 'dry-run',
      metrics: summary,
      count: usable.length,
    }, opts.trailPath);
    return { status: 'dry-run', metrics: summary, episodesUsed: usable.length };
  }

  // 2. Real training
  const facade = createSkillPolicy({ policyPath: opts.policyPath, config, logger });
  const out = await facade.updatePolicy(usable);

  await appendTrail({
    action: 'trained',
    metrics: out.metrics,
    snapshotId: out.policy?.snapshotId ?? null,
    count: usable.length,
  }, opts.trailPath);

  logger.info(
    `trained skill policy: touched=${out.metrics?.skillsTouched ?? 0} used=${out.metrics?.episodesUsed ?? 0} explore=${out.metrics?.explorationSkipped ?? 0}`,
  );

  return {
    status: 'trained',
    metrics: out.metrics,
    policy: out.policy,
    episodesUsed: usable.length,
  };
}

/**
 * Dry-run summary — counts skill occurrences and notes which are already in
 * the current policy. Pure; no disk IO of its own.
 *
 * @param {object[]} episodes
 * @param {object} prevPolicy
 * @returns {{
 *   skills: Record<string, { count: number, known: boolean }>,
 *   uniqueSkills: number,
 *   totalEpisodes: number,
 * }}
 */
export function summarizeEpisodes(episodes, prevPolicy) {
  const known = new Set(Object.keys(prevPolicy?.skills ?? {}));
  const tally = {};
  for (const ep of episodes ?? []) {
    if (!ep || !Array.isArray(ep.skillsUsed)) continue;
    for (const s of ep.skillsUsed) {
      if (typeof s !== 'string' || !s) continue;
      if (!tally[s]) tally[s] = { count: 0, known: known.has(s) };
      tally[s].count++;
    }
  }
  return {
    skills: tally,
    uniqueSkills: Object.keys(tally).length,
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
  runNightlySkillTrainer({
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
      process.stderr.write(`[skill-trainer] FATAL ${err?.message ?? err}\n`);
      process.exit(1);
    });
}

// Exported for tests that need a direct path handle.
export { resolvePolicyPaths };
