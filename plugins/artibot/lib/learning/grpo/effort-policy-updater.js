/**
 * GRPO-Tuned Adaptive Effort/Budget Policy Updater (P3, L3 learning).
 *
 * Nightly, dormant-by-default trainer that turns verifiable-reward episodes
 * (carrying the additive `effort` / `command` / `budget` / `tokensUsed` meta
 * fields recorded by {@link module:lib/learning/grpo/reward-metrics}) into a
 * small learned overlay:
 *
 *   - `bandShifts[command]`   integer in {-1, 0, +1} — nudge the effort baseline
 *   - `budgetMultipliers[band]` in [0.5, 1.5] — scale the token budget
 *
 * The overlay is consumed (read-only) by the L4 reader
 * {@link module:lib/cognitive/effort-policy-config}; this module only WRITES the
 * policy file (atomic + N-snapshot rotation), so there is no L3↔L4 import cycle.
 *
 * Update rule (per command / band, GRPO-flavoured):
 *   - negative mean reward AND high token consumption -> bandShift -1
 *   - high mean reward                                -> bandShift +1
 *   - clip rate > clipHigh                            -> budget multiplier +step
 *   - negative mean reward                            -> budget multiplier -step
 * Deltas are clamped, then the whole change vector is scaled (KL-style) so its
 * L1 norm never exceeds `deltaL1Cap`. Cold-start guard: fewer than
 * `coldStartEpisodes` usable episodes -> return prev overlay, no disk write.
 *
 * Zero external deps. Deterministic. Mirrors the structure of
 * {@link module:lib/learning/grpo/policy-updater}.
 *
 * @module lib/learning/grpo/effort-policy-updater
 */

import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonFile, writeJsonFile } from '../../core/file.js';
import { getHomeDir } from '../../core/platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLICY_VERSION = 1;

const EFFORT_BANDS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** Trainer defaults — mirror `learning.grpoRouting.effortPolicy.*`. */
export const EFFORT_TRAINER_DEFAULTS = Object.freeze({
  coldStartEpisodes: 150,
  minPerKey: 20,
  negReward: -0.2,
  posReward: 0.3,
  highTokenRatio: 0.7,
  clipHigh: 0.25,
  multStep: 0.1,
  bandShiftClamp: 1,
  multMin: 0.5,
  multMax: 1.5,
  deltaL1Cap: 1.5,
  snapshotCount: 3,
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function accStats(acc, reward, tokens) {
  acc.count += 1;
  acc.rewardSum += reward;
  if (isFiniteNum(tokens)) {
    acc.tokenSum += tokens;
    acc.tokenCount += 1;
  }
}

/**
 * Roll episodes up into per-command and per-effort statistics. Episodes without
 * a finite reward are skipped. Per-command keys group by `command`; per-effort
 * keys group by `effort` band.
 *
 * @param {object[]} episodes
 * @returns {{
 *   perCommand: Record<string, {count:number, meanReward:number, meanTokens:number}>,
 *   perEffort: Record<string, {count:number, clipRate:number, meanReward:number}>,
 * }}
 */
export function rollupEffortEpisodes(episodes) {
  const cmd = new Map();
  const eff = new Map();
  for (const e of Array.isArray(episodes) ? episodes : []) {
    if (!e || typeof e !== 'object' || !isFiniteNum(e.reward)) continue;
    if (typeof e.command === 'string' && e.command) {
      const a = cmd.get(e.command) || { count: 0, rewardSum: 0, tokenSum: 0, tokenCount: 0 };
      accStats(a, e.reward, e.tokensUsed);
      cmd.set(e.command, a);
    }
    if (typeof e.effort === 'string' && EFFORT_BANDS.includes(e.effort)) {
      const a = eff.get(e.effort) || { count: 0, rewardSum: 0, clipped: 0 };
      a.count += 1;
      a.rewardSum += e.reward;
      if (e.clipped === true || e.reward <= -1.5 || e.reward >= 1.2) a.clipped += 1;
      eff.set(e.effort, a);
    }
  }
  return { perCommand: finalizeCommand(cmd), perEffort: finalizeEffort(eff) };
}

function finalizeCommand(map) {
  const out = {};
  for (const [k, a] of map) {
    out[k] = {
      count: a.count,
      meanReward: a.count > 0 ? a.rewardSum / a.count : 0,
      meanTokens: a.tokenCount > 0 ? a.tokenSum / a.tokenCount : 0,
    };
  }
  return out;
}

function finalizeEffort(map) {
  const out = {};
  for (const [k, a] of map) {
    out[k] = {
      count: a.count,
      clipRate: a.count > 0 ? a.clipped / a.count : 0,
      meanReward: a.count > 0 ? a.rewardSum / a.count : 0,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overlay derivation
// ---------------------------------------------------------------------------

function clampInt(v, lim) {
  const i = Math.round(v);
  return Math.max(-lim, Math.min(lim, i));
}

function clampMult(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Derive the next bandShifts from per-command stats vs the previous overlay.
 * @param {Record<string, object>} perCommand @param {Record<string, number>} prevShifts @param {object} o
 * @returns {Record<string, number>}
 */
function deriveBandShifts(perCommand, prevShifts, o) {
  const next = { ...prevShifts };
  for (const [cmd, s] of Object.entries(perCommand)) {
    if (s.count < o.minPerKey) continue;
    const prior = isFiniteNum(prevShifts[cmd]) ? prevShifts[cmd] : 0;
    let shift = prior;
    if (s.meanReward < o.negReward && s.meanTokens >= o.highTokenRatio) shift = prior - 1;
    else if (s.meanReward > o.posReward) shift = prior + 1;
    next[cmd] = clampInt(shift, o.bandShiftClamp);
  }
  return next;
}

/**
 * Derive the next budgetMultipliers from per-effort stats vs the previous overlay.
 * @param {Record<string, object>} perEffort @param {Record<string, number>} prevMult @param {object} o
 * @returns {Record<string, number>}
 */
function deriveBudgetMultipliers(perEffort, prevMult, o) {
  const next = { ...prevMult };
  for (const [band, s] of Object.entries(perEffort)) {
    if (!EFFORT_BANDS.includes(band) || s.count < o.minPerKey) continue;
    const prior = isFiniteNum(prevMult[band]) ? prevMult[band] : 1;
    let mult = prior;
    if (s.clipRate > o.clipHigh) mult = prior + o.multStep;
    else if (s.meanReward < o.negReward) mult = prior - o.multStep;
    next[band] = clampMult(mult, o.multMin, o.multMax);
  }
  return next;
}

/**
 * KL-style delta cap: if the total L1 change (band shifts + multiplier deltas)
 * from `prev` exceeds `deltaL1Cap`, scale every delta by the same factor so the
 * capped overlay stays close to the previous one.
 * @param {object} next @param {object} prev @param {number} cap
 * @returns {object} possibly-scaled { bandShifts, budgetMultipliers }
 */
function capDelta(next, prev, cap) {
  const shiftKeys = new Set([...Object.keys(prev.bandShifts), ...Object.keys(next.bandShifts)]);
  const multKeys = new Set([...Object.keys(prev.budgetMultipliers), ...Object.keys(next.budgetMultipliers)]);
  let l1 = 0;
  for (const k of shiftKeys) l1 += Math.abs((next.bandShifts[k] ?? 0) - (prev.bandShifts[k] ?? 0));
  for (const k of multKeys) l1 += Math.abs((next.budgetMultipliers[k] ?? 1) - (prev.budgetMultipliers[k] ?? 1));
  if (!(l1 > cap) || l1 === 0) return next;
  const scale = cap / l1;
  const bandShifts = {};
  for (const k of shiftKeys) {
    const base = prev.bandShifts[k] ?? 0;
    bandShifts[k] = Math.round(base + ((next.bandShifts[k] ?? 0) - base) * scale);
  }
  const budgetMultipliers = {};
  for (const k of multKeys) {
    const base = prev.budgetMultipliers[k] ?? 1;
    budgetMultipliers[k] = base + ((next.budgetMultipliers[k] ?? 1) - base) * scale;
  }
  return { bandShifts, budgetMultipliers };
}

/**
 * Derive the next overlay from a rollup + previous overlay.
 *
 * @param {ReturnType<typeof rollupEffortEpisodes>} rollup
 * @param {{bandShifts?:object, budgetMultipliers?:object}|null} [prevOverlay]
 * @param {object} [opts] - overrides for {@link EFFORT_TRAINER_DEFAULTS}
 * @returns {{ bandShifts: Record<string,number>, budgetMultipliers: Record<string,number> }}
 */
export function deriveOverlay(rollup, prevOverlay = null, opts = {}) {
  const o = { ...EFFORT_TRAINER_DEFAULTS, ...opts };
  const prev = {
    bandShifts: { ...(prevOverlay?.bandShifts ?? {}) },
    budgetMultipliers: { ...(prevOverlay?.budgetMultipliers ?? {}) },
  };
  const candidate = {
    bandShifts: deriveBandShifts(rollup?.perCommand ?? {}, prev.bandShifts, o),
    budgetMultipliers: deriveBudgetMultipliers(rollup?.perEffort ?? {}, prev.budgetMultipliers, o),
  };
  return capDelta(candidate, prev, o.deltaL1Cap);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return getHomeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(getHomeDir(), p.slice(2));
  return p;
}

/**
 * Resolve the effort-policy file + snapshot directory.
 * @param {string} [policyPath]
 * @returns {{ policyFile: string, snapshotDir: string }}
 */
export function resolveEffortPolicyPaths(policyPath) {
  const expanded = expandHome(policyPath);
  const file = expanded && path.isAbsolute(expanded)
    ? expanded
    : path.join(getHomeDir(), '.claude', 'artibot', 'policies', 'effort-policy-v1.json');
  return { policyFile: file, snapshotDir: path.join(path.dirname(file), 'snapshots') };
}

/**
 * Load the current effort policy. Returns `null` when missing/malformed/version
 * mismatch. Never throws.
 * @param {string} [policyPath]
 * @returns {Promise<object|null>}
 */
export async function loadEffortPolicy(policyPath) {
  const { policyFile } = resolveEffortPolicyPaths(policyPath);
  const data = await readJsonFile(policyFile);
  if (!data || typeof data !== 'object' || data.version !== POLICY_VERSION) return null;
  return data;
}

function makeSnapshotId(now = new Date()) {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `effort-v${POLICY_VERSION}-${iso}-${rand}`;
}

async function pruneSnapshots(snapshotDir, retain) {
  const fs = await import('node:fs/promises');
  let entries;
  try {
    entries = await fs.readdir(snapshotDir);
  } catch {
    return;
  }
  const files = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(snapshotDir, name);
    try {
      const stat = await fs.stat(full);
      files.push({ full, mtime: stat.mtimeMs });
    } catch { /* skip */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(Math.max(0, retain))) {
    try { await fs.unlink(f.full); } catch { /* best-effort */ }
  }
}

/**
 * Atomically write the overlay policy + a rotating snapshot. Keeps the newest
 * `snapshotCount` snapshots.
 *
 * @param {{bandShifts:object, budgetMultipliers:object}} overlay
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {number} [options.trainedOnEpisodes]
 * @param {number} [options.snapshotCount=EFFORT_TRAINER_DEFAULTS.snapshotCount]
 * @param {() => Date} [options.now] - injectable clock for deterministic tests
 *   (default `() => new Date()`); production behaviour is unchanged.
 * @returns {Promise<{ policy: object, snapshotId: string, policyFile: string }>}
 */
export async function saveEffortPolicy(overlay, options = {}) {
  const { policyFile, snapshotDir } = resolveEffortPolicyPaths(options.policyPath);
  const retain = options.snapshotCount ?? EFFORT_TRAINER_DEFAULTS.snapshotCount;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  await ensureDir(path.dirname(policyFile));
  await ensureDir(snapshotDir);
  const stamp = now();
  const snapshotId = makeSnapshotId(stamp);
  const policy = {
    version: POLICY_VERSION,
    bandShifts: { ...overlay.bandShifts },
    budgetMultipliers: { ...overlay.budgetMultipliers },
    trainedAt: stamp.toISOString(),
    trainedOnEpisodes: options.trainedOnEpisodes ?? 0,
    snapshotId,
  };
  await atomicWriteJson(policyFile, policy);
  await writeJsonFile(path.join(snapshotDir, `${snapshotId}.json`), policy);
  await pruneSnapshots(snapshotDir, retain);
  return { policy, snapshotId, policyFile };
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * Create a stateful effort-policy updater scoped to a policy file.
 *
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {object} [options.config] - effort-policy config block (coldStartEpisodes, snapshotCount, ...)
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]
 * @param {() => Date} [options.now] - injectable clock for deterministic tests
 *   (default `() => new Date()`); production behaviour is unchanged.
 * @returns {{
 *   loadPolicy: () => Promise<object|null>,
 *   trainFromEpisodes: (episodes: object[]) =>
 *     Promise<{ policy: object|null, overlay: object, episodesUsed: number, coldStart?: boolean, skipped?: boolean }>,
 * }}
 */
export function createEffortPolicyUpdater(options = {}) {
  const policyPath = options.policyPath;
  const config = { ...EFFORT_TRAINER_DEFAULTS, ...(options.config ?? {}) };
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };
  const now = typeof options.now === 'function' ? options.now : undefined;

  return {
    loadPolicy: () => loadEffortPolicy(policyPath),

    async trainFromEpisodes(episodes) {
      const usable = (Array.isArray(episodes) ? episodes : []).filter(
        (e) => e && typeof e === 'object' && isFiniteNum(e.reward),
      );
      const prev = await loadEffortPolicy(policyPath);
      const prevOverlay = prev
        ? { bandShifts: prev.bandShifts ?? {}, budgetMultipliers: prev.budgetMultipliers ?? {} }
        : { bandShifts: {}, budgetMultipliers: {} };

      // Cold-start guard: too few usable episodes -> keep prev, no disk write.
      if (usable.length < config.coldStartEpisodes) {
        logger.info(`effort-policy cold-start deferred: ${usable.length} < ${config.coldStartEpisodes}`);
        return { policy: prev, overlay: prevOverlay, episodesUsed: usable.length, skipped: true };
      }

      const rollup = rollupEffortEpisodes(usable);
      const overlay = deriveOverlay(rollup, prevOverlay, config);
      const saved = await saveEffortPolicy(overlay, {
        policyPath,
        trainedOnEpisodes: usable.length,
        snapshotCount: config.snapshotCount,
        ...(now ? { now } : {}),
      });
      return {
        policy: saved.policy,
        overlay,
        episodesUsed: usable.length,
        coldStart: !prev,
      };
    },
  };
}
