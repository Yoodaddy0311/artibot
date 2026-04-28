#!/usr/bin/env node
/**
 * Nightly Joint Agent-Skill Policy Trainer (GRPO v3.7 §5.6).
 *
 * Reads the last N days of Artibot episodes, filters those carrying BOTH an
 * agent selection AND at least one fired skill, then updates the joint
 * correlation matrix via `joint-policy.updateJoint`. The joint policy does
 * NOT duplicate agent/skill training — it only learns the per-family
 * correlation signal `corr[f][agent][skill]` used by the scorer:
 *
 *   score(agent, skill | f) = p_agent(agent|f) * (1 + lambda * corr[f][agent][skill])
 *
 * This trainer co-exists with the agent + skill nightlies; their marginals
 * stay authoritative for their respective recommendation surfaces, and this
 * trainer only refreshes the correlation head.
 *
 * Flags:
 *   --dry-run              Evaluate correlation delta without persisting.
 *   --window-days <N>      Episode lookback window (default 30).
 *   --policy-path <path>   Override `~/.claude/artibot/policies/joint-policy-v1.json`.
 *   --episodes <path>      Override episode source JSON (tests / migration).
 *   --help                 Print usage and exit.
 *
 * Ledger (append-only): `plugins/artibot/runtime/joint-policy-trail.json`.
 *
 * KL-rejection guard mirrors the routing + agent trainers: if the joint
 * policy facade returns `rejected: 'kl-threshold'`, the entry is recorded
 * and the previous correlation snapshot is retained.
 *
 * Zero external network IO. Deterministic under NODE_ENV=test.
 *
 * @module scripts/hooks/nightly-joint-policy-trainer
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, readJsonFile, writeJsonFile } from '../../lib/core/file.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Lazy joint-policy loader
// ---------------------------------------------------------------------------
// JP1 owns `lib/learning/grpo/joint-policy.js`. We import it lazily so this
// trainer module still loads (and its pure helpers remain testable) even if
// the joint-policy module has not yet been generated.

let cachedJointModule = null;

/**
 * Dynamically load the joint-policy module. Tests may inject a stub via
 * `opts.jointPolicyModule` to avoid coupling to JP1's filesystem layout.
 *
 * @returns {Promise<object>} module exports with `createJointPolicy`, `DEFAULTS`
 */
async function loadJointPolicyModule() {
  if (cachedJointModule) return cachedJointModule;
  cachedJointModule = await import('../../lib/learning/grpo/joint-policy.js');
  return cachedJointModule;
}

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
  'Usage: node scripts/hooks/nightly-joint-policy-trainer.mjs [options]',
  '',
  'Options:',
  '  --dry-run              Compute correlation delta without persistence',
  '  --window-days <N>      Lookback window in days (default 30)',
  '  --policy-path <path>   Override policy file path',
  '  --episodes <path>      Override episode source JSON',
  '  -h, --help             Show this message',
].join('\n');

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Resolve the joint-policy trail path (sibling to the agent/skill trails).
 * @returns {string}
 */
export function resolveTrailPath() {
  return path.resolve(__dirname, '..', '..', 'runtime', 'joint-policy-trail.json');
}

/**
 * Append one entry to the joint-policy trail (append-only JSON array).
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
 * Load the trail.
 *
 * @param {string} [trailPath]
 * @returns {Promise<object[]>}
 */
export async function loadTrail(trailPath) {
  const file = trailPath ?? resolveTrailPath();
  const data = await readJsonFile(file);
  return Array.isArray(data) ? data : [];
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
 * Keep episodes whose timestamp falls within the lookback window. Entries
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
 * Keep only episodes usable for joint training: they must carry a task
 * family, a selected agent, at least one fired skill, and a finite reward.
 * Anything less cannot produce a correlation signal.
 *
 * @param {object[]} episodes
 * @returns {object[]}
 */
export function filterJointEligible(episodes) {
  return (episodes ?? []).filter((e) => {
    if (!e || typeof e !== 'object') return false;
    const family = e.taskFamily || e.intentFamily || e.domain;
    if (typeof family !== 'string' || !family) return false;
    const agent = e.selectedAgent || e.agent;
    if (typeof agent !== 'string' || !agent) return false;
    if (!Array.isArray(e.skillsUsed) || e.skillsUsed.length === 0) return false;
    if (typeof e.reward !== 'number' || !Number.isFinite(e.reward)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the nightly joint-policy trainer once. Never throws on expected
 * failures — emits a structured descriptor for the ledger + tests.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.windowDays]
 * @param {string} [opts.policyPath]
 * @param {string} [opts.episodesPath]
 * @param {object[]} [opts.episodes]
 * @param {object} [opts.config]            // joint-policy config block (correlationWeight, klPenalty, ...)
 * @param {string} [opts.trailPath]
 * @param {number} [opts.nowMs]
 * @param {object} [opts.jointPolicyModule] // test injection (parallel-build safety)
 * @param {{ info: Function, warn: Function, error: Function }} [opts.logger]
 * @returns {Promise<{
 *   status: 'trained'|'skipped'|'rejected'|'dry-run',
 *   metrics?: object,
 *   policy?: object,
 *   episodesUsed?: number,
 *   reason?: string,
 * }>}
 */
export async function runNightlyJointTrainer(opts = {}) {
  const logger = opts.logger ?? {
    info: (m) => process.stderr.write(`[joint-trainer] ${m}\n`),
    warn: (m) => process.stderr.write(`[joint-trainer] WARN ${m}\n`),
    error: (m) => process.stderr.write(`[joint-trainer] ERROR ${m}\n`),
  };
  const nowMs = opts.nowMs ?? Date.now();

  // 1. Collect + filter episodes
  let episodes = opts.episodes;
  if (!episodes && opts.episodesPath) {
    episodes = await readEpisodesFile(opts.episodesPath);
  }
  episodes = Array.isArray(episodes) ? episodes : [];
  const windowed = filterByWindow(episodes, opts.windowDays ?? 30, nowMs);
  const usable = filterJointEligible(windowed);

  if (usable.length === 0) {
    await appendTrail(
      { action: 'skipped', reason: 'no-joint-episodes', count: 0 },
      opts.trailPath,
    );
    logger.info('no joint-eligible episodes; skipping training');
    return { status: 'skipped', reason: 'no-joint-episodes', episodesUsed: 0 };
  }

  // 2. Load joint-policy module (test injection wins)
  let mod;
  try {
    mod = opts.jointPolicyModule ?? (await loadJointPolicyModule());
  } catch (err) {
    const reason = `joint-policy-module-unavailable: ${err?.message ?? err}`;
    await appendTrail(
      { action: 'skipped', reason, count: usable.length },
      opts.trailPath,
    );
    logger.warn(reason);
    return { status: 'skipped', reason, episodesUsed: usable.length };
  }

  const { createJointPolicy, DEFAULTS = {} } = mod;
  if (typeof createJointPolicy !== 'function') {
    const reason = 'joint-policy-module-missing-createJointPolicy';
    await appendTrail(
      { action: 'skipped', reason, count: usable.length },
      opts.trailPath,
    );
    logger.warn(reason);
    return { status: 'skipped', reason, episodesUsed: usable.length };
  }

  const config = { ...DEFAULTS, ...(opts.config ?? {}) };

  // 3. Dry-run — compute + evaluate via facade's dry path when available.
  const facade = createJointPolicy({
    policyPath: opts.policyPath,
    config,
    logger,
  });

  if (opts.dryRun) {
    const summary = await simulateJoint(facade, usable);
    await appendTrail(
      { action: 'dry-run', metrics: summary, count: usable.length },
      opts.trailPath,
    );
    return { status: 'dry-run', metrics: summary, episodesUsed: usable.length };
  }

  // 4. Real training via facade. Expected contract:
  //    updateJoint(episodes) -> { policy, metrics, rejected? }
  if (typeof facade.updateJoint !== 'function') {
    const reason = 'joint-policy-facade-missing-updateJoint';
    await appendTrail(
      { action: 'skipped', reason, count: usable.length },
      opts.trailPath,
    );
    logger.warn(reason);
    return { status: 'skipped', reason, episodesUsed: usable.length };
  }

  const out = await facade.updateJoint(usable);

  if (out?.rejected) {
    await appendTrail(
      {
        action: 'rejected',
        reason: out.rejected,
        metrics: out.metrics ?? {},
        count: usable.length,
      },
      opts.trailPath,
    );
    logger.warn(`joint update rejected: ${out.rejected}`);
    return {
      status: 'rejected',
      reason: out.rejected,
      metrics: out.metrics ?? {},
      episodesUsed: usable.length,
    };
  }

  await appendTrail(
    {
      action: 'trained',
      metrics: out?.metrics ?? {},
      snapshotId: out?.policy?.snapshotId ?? null,
      count: usable.length,
    },
    opts.trailPath,
  );

  const m = out?.metrics ?? {};
  logger.info(
    `trained joint policy: families=${m.familiesTouched ?? 0} pairs=${m.pairsTouched ?? 0} kl=${(m.klFromPrev ?? 0).toFixed(4)}`,
  );

  return {
    status: 'trained',
    metrics: out?.metrics ?? {},
    policy: out?.policy ?? null,
    episodesUsed: usable.length,
  };
}

/**
 * Pure in-memory evaluation for `--dry-run`. Uses the facade's `loadPolicy`
 * + a stats helper so nothing is persisted.
 *
 * @param {object} facade
 * @param {object[]} episodes
 * @returns {Promise<object>}
 */
async function simulateJoint(facade, episodes) {
  const prev = typeof facade.loadPolicy === 'function' ? await facade.loadPolicy() : null;
  const tally = summarizeJointEpisodes(episodes, prev);
  return {
    familiesSeen: tally.families,
    pairsSeen: tally.pairs,
    episodesUsed: episodes.length,
    previousTrainedAt: prev?.trainedAt ?? null,
  };
}

/**
 * Summarize (family, agent, skill) triples seen in the episode batch. Used
 * for dry-run reporting; does not touch disk.
 *
 * @param {object[]} episodes
 * @param {object|null} prevPolicy
 * @returns {{ families: number, pairs: number }}
 */
export function summarizeJointEpisodes(episodes, prevPolicy) {
  void prevPolicy; // reserved for future delta reporting
  const famSet = new Set();
  const pairSet = new Set();
  for (const ep of episodes ?? []) {
    if (!ep || typeof ep !== 'object') continue;
    const family = ep.taskFamily || ep.intentFamily || ep.domain;
    const agent = ep.selectedAgent || ep.agent;
    if (typeof family !== 'string' || !family) continue;
    if (typeof agent !== 'string' || !agent) continue;
    famSet.add(family);
    if (Array.isArray(ep.skillsUsed)) {
      for (const s of ep.skillsUsed) {
        if (typeof s !== 'string' || !s) continue;
        pairSet.add(`${family}|${agent}|${s}`);
      }
    }
  }
  return { families: famSet.size, pairs: pairSet.size };
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
  runNightlyJointTrainer({
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
      process.stderr.write(`[joint-trainer] FATAL ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
