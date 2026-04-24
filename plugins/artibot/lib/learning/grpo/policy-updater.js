/**
 * GRPO-RLVR Policy Updater (Phase B of v3.4 routing policy).
 *
 * Maintains a 9-dim logistic-regression routing policy trained from
 * verifiable-reward episodes using Group Relative Policy Optimization
 * with a KL penalty against the previous snapshot.
 *
 * Pipeline:
 *   1. Cold-start warmup (first N episodes) — MSE fit to heuristic labels.
 *   2. Batch GRPO — group by intent-family, compute rank-advantage,
 *      logistic-regression gradient, KL penalty, clip to [-5, +5].
 *   3. Evaluate — log-loss, accuracy vs heuristic, KL from prev theta.
 *   4. Persist atomically to `~/.claude/artibot/policies/routing-policy-v1.json`
 *      with N=3 snapshot retention in `policies/snapshots/`.
 *
 * See `_design/grpo-rlvr-routing-2026-04-24.md` Sections 3.3, 3.5, 4.3, 7.2.
 *
 * Zero external deps, deterministic under `NODE_ENV=test`, no network IO.
 *
 * @module lib/learning/grpo/policy-updater
 */

import path from 'node:path';
import { ensureDir, readJsonFile, writeJsonFile } from '../../core/file.js';
import { getHomeDir } from '../../core/platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FEATURE_NAMES = Object.freeze([
  'steps',
  'domains',
  'uncertainty',
  'risk',
  'novelty',
  's1_success_rate',
  'session_depth',
  'error_rate',
  'bias',
]);

export const FEATURE_DIM = FEATURE_NAMES.length; // 9

/** Training defaults — mirror `learning.grpoRouting.*` config block. */
export const DEFAULTS = Object.freeze({
  learningRate: 0.02,
  klPenalty: 0.01,
  clipRange: 5,
  coldStartEpisodes: 200,
  warmupIterations: 120,
  warmupLearningRate: 0.05,
  snapshotCount: 3,
  klRejectThreshold: 0.25,
  accuracyRollbackThreshold: 0.5,
  rollbackConsecutiveNights: 3,
  maxBatchIterations: 30,
});

const POLICY_VERSION = 1;
const MODEL_TYPE = 'logistic-regression';

// ---------------------------------------------------------------------------
// Linear algebra primitives
// ---------------------------------------------------------------------------

/**
 * Numerically stable sigmoid.
 *
 * @param {number} z
 * @returns {number} in (0, 1)
 */
export function sigmoid(z) {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

/**
 * Dot product of two fixed-length vectors. Length mismatch -> 0.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function dot(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/**
 * Policy forward pass: p(S2 | x) = sigmoid(theta . x).
 *
 * @param {number[]} theta - Weight vector (length FEATURE_DIM).
 * @param {number[]} x - Feature vector (length FEATURE_DIM).
 * @returns {number}
 */
export function predict(theta, x) {
  return sigmoid(dot(theta, x));
}

/**
 * Clip every component of `theta` into `[-range, +range]` (stability bound).
 *
 * @param {number[]} theta
 * @param {number} range
 * @returns {number[]}
 */
export function clipTheta(theta, range = DEFAULTS.clipRange) {
  const r = Math.abs(range);
  return theta.map((v) => {
    if (!Number.isFinite(v)) return 0;
    if (v > r) return r;
    if (v < -r) return -r;
    return v;
  });
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/**
 * Build a 9-dim feature vector from a router classification + runtime context.
 * All entries are clipped to `[0, 1]` (except bias = 1.0).
 *
 * Features (by index):
 *   0: factors.steps
 *   1: factors.domains
 *   2: factors.uncertainty
 *   3: factors.risk
 *   4: factors.novelty
 *   5: recent_s1_success_rate
 *   6: session_depth_norm  (= min(depth/20, 1))
 *   7: error_rate_ma10
 *   8: bias (=1.0)
 *
 * @param {{ factors?: Record<string, number> }} classification
 * @param {{
 *   s1SuccessRate?: number,
 *   sessionDepth?: number,
 *   errorRateMa10?: number,
 * }} [context]
 * @returns {number[]} feature vector of length 9
 */
export function buildFeatureVector(classification, context = {}) {
  const factors = classification?.factors ?? {};
  const unit = (v) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    return Math.max(0, Math.min(1, n));
  };
  const depthNorm = unit((context.sessionDepth ?? 0) / 20);

  return [
    unit(factors.steps),
    unit(factors.domains),
    unit(factors.uncertainty),
    unit(factors.risk),
    unit(factors.novelty),
    unit(context.s1SuccessRate),
    depthNorm,
    unit(context.errorRateMa10),
    1.0,
  ];
}

// ---------------------------------------------------------------------------
// Episode helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a single episode into `{ x, r, label, group, exploration }`.
 * Returns `null` when the episode is unusable (missing features or reward).
 *
 * Expected episode shape (from reward-capture.js pipeline):
 *   {
 *     reward: number,                        // verifiable reward in [-1.5, +1.2]
 *     classification: { factors, system },   // from router.classifyComplexity
 *     context: { s1SuccessRate, sessionDepth, errorRateMa10 },
 *     intentFamily: string,                  // from pattern-analyzer
 *     domain?: string,
 *     recentCommand?: string,
 *     isExploration?: boolean,
 *   }
 *
 * @param {object} episode
 * @returns {{ x:number[], r:number, label:0|1, group:string, exploration:boolean } | null}
 */
export function normalizeEpisode(episode) {
  if (!episode || typeof episode !== 'object') return null;
  if (typeof episode.reward !== 'number' || !Number.isFinite(episode.reward)) return null;

  const x = buildFeatureVector(episode.classification ?? {}, episode.context ?? {});
  if (!Array.isArray(x) || x.length !== FEATURE_DIM) return null;

  const system = episode.classification?.system ?? episode.system;
  const label = system === 2 ? 1 : 0;

  const family = episode.intentFamily || episode.domain || 'general';
  const recentCommand = episode.recentCommand ? `|${episode.recentCommand}` : '';
  const group = `${family}${recentCommand}`;

  return {
    x,
    r: episode.reward,
    label,
    group,
    exploration: Boolean(episode.isExploration),
  };
}

/**
 * Bucket normalized episodes by group key. Exploration-flagged episodes
 * are kept but excluded from reward-based policy updates (noise guard).
 *
 * @param {object[]} episodes
 * @returns {Map<string, ReturnType<typeof normalizeEpisode>[]>}
 */
export function groupEpisodes(episodes) {
  const groups = new Map();
  for (const raw of episodes ?? []) {
    const n = normalizeEpisode(raw);
    if (!n) continue;
    const bucket = groups.get(n.group) ?? [];
    bucket.push(n);
    groups.set(n.group, bucket);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// GRPO advantage / gradient
// ---------------------------------------------------------------------------

/**
 * Group-relative advantage: (r_i - mean) / std. Epsilon-guarded std.
 *
 * @param {number[]} rewards
 * @returns {number[]} advantages, same length
 */
export function computeAdvantages(rewards) {
  const n = rewards.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  let sum = 0;
  for (const r of rewards) sum += r;
  const mean = sum / n;
  let sqSum = 0;
  for (const r of rewards) {
    const d = r - mean;
    sqSum += d * d;
  }
  const variance = sqSum / n;
  const std = Math.sqrt(variance);
  const eps = 1e-6;
  const denom = std > eps ? std : 1;
  return rewards.map((r) => (r - mean) / denom);
}

/**
 * Logistic-regression gradient for a single (x, label) pair, scaled by advantage.
 * grad_i = advantage * (label - sigmoid(theta . x)) * x_i
 *
 * @param {number[]} theta
 * @param {number[]} x
 * @param {0|1} label
 * @param {number} advantage
 * @returns {number[]}
 */
export function logisticGradient(theta, x, label, advantage) {
  const p = predict(theta, x);
  const residual = label - p;
  const scale = advantage * residual;
  return x.map((xi) => scale * xi);
}

/**
 * KL-penalty gradient term: lambda * (theta - theta_prev)^2 differentiates to
 * 2 * lambda * (theta - theta_prev). We fold the 2 into `lambda` at call-site.
 *
 * Returns the shrinkage term to SUBTRACT from theta after adding grad:
 *   theta += lr * grad - klPenalty * (theta - theta_prev)
 *
 * @param {number[]} theta
 * @param {number[]} thetaPrev
 * @param {number} lambda
 * @returns {number[]} shrinkage vector (already positive-sign)
 */
export function klShrinkage(theta, thetaPrev, lambda) {
  if (lambda <= 0 || !Array.isArray(thetaPrev) || thetaPrev.length !== theta.length) {
    return theta.map(() => 0);
  }
  return theta.map((v, i) => lambda * (v - thetaPrev[i]));
}

/**
 * Symmetric L2 distance between two theta checkpoints (used as "KL-like"
 * divergence for a linear policy). For logistic regression this is a
 * reasonable proxy for KL without requiring a distribution over outputs.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function klFromPrev(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Cold-start warmup
// ---------------------------------------------------------------------------

/**
 * Cold-start supervised warmup: fit theta so that sigmoid(theta . x) matches
 * the heuristic decisions of the first N episodes (MSE minimized via plain
 * gradient descent). Result seeds GRPO with "agree with heuristic" prior.
 *
 * Requires at least `coldStartEpisodes` normalizable episodes.
 *
 * @param {object[]} episodes
 * @param {object} [options]
 * @param {number} [options.iterations=DEFAULTS.warmupIterations]
 * @param {number} [options.learningRate=DEFAULTS.warmupLearningRate]
 * @param {number} [options.minEpisodes=DEFAULTS.coldStartEpisodes]
 * @returns {{ theta: number[], iterations: number, finalMse: number, episodesUsed: number } | null}
 */
export function coldStartWarmup(episodes, options = {}) {
  const iters = options.iterations ?? DEFAULTS.warmupIterations;
  const lr = options.learningRate ?? DEFAULTS.warmupLearningRate;
  const minEps = options.minEpisodes ?? DEFAULTS.coldStartEpisodes;

  const normalized = (episodes ?? [])
    .map((e) => normalizeEpisode(e))
    .filter((e) => e !== null);

  if (normalized.length < minEps) return null;

  let theta = new Array(FEATURE_DIM).fill(0);
  let finalMse = 0;

  for (let it = 0; it < iters; it++) {
    const grad = new Array(FEATURE_DIM).fill(0);
    let mseSum = 0;
    for (const ep of normalized) {
      const p = predict(theta, ep.x);
      const err = p - ep.label;       // d/dtheta of 0.5 * (p - y)^2
      const dSigmoid = p * (1 - p);   // chain rule
      const scale = err * dSigmoid;
      mseSum += err * err;
      for (let i = 0; i < FEATURE_DIM; i++) {
        grad[i] += scale * ep.x[i];
      }
    }
    const invN = 1 / normalized.length;
    for (let i = 0; i < FEATURE_DIM; i++) {
      theta[i] -= lr * grad[i] * invN;
    }
    finalMse = mseSum * invN;
  }

  theta = clipTheta(theta);
  return { theta, iterations: iters, finalMse, episodesUsed: normalized.length };
}

// ---------------------------------------------------------------------------
// Batch training
// ---------------------------------------------------------------------------

/**
 * Train the policy on a batch of episodes using GRPO + KL penalty.
 * Groups by intent-family, computes rank-advantage within each group,
 * applies logistic-regression gradient, KL shrinkage vs `thetaPrev`,
 * clips to the stability range, and returns the updated theta.
 *
 * Non-exploration episodes only feed the gradient; exploration episodes
 * are tracked but excluded to avoid penalizing deliberate probes.
 *
 * @param {object[]} episodes
 * @param {number[]} thetaPrev - previous theta (same length as FEATURE_DIM)
 * @param {object} [options]
 * @param {number} [options.learningRate=DEFAULTS.learningRate]
 * @param {number} [options.klPenalty=DEFAULTS.klPenalty]
 * @param {number} [options.iterations=1]
 * @returns {{
 *   theta: number[],
 *   groupsUsed: number,
 *   episodesUsed: number,
 *   explorationSkipped: number,
 * }}
 */
export function trainBatch(episodes, thetaPrev, options = {}) {
  const lr = options.learningRate ?? DEFAULTS.learningRate;
  const lambda = options.klPenalty ?? DEFAULTS.klPenalty;
  const iterations = Math.max(1, Math.min(DEFAULTS.maxBatchIterations, options.iterations ?? 1));

  const baseTheta = Array.isArray(thetaPrev) && thetaPrev.length === FEATURE_DIM
    ? [...thetaPrev]
    : new Array(FEATURE_DIM).fill(0);

  const groups = groupEpisodes(episodes);

  let theta = [...baseTheta];
  let groupsUsed = 0;
  let episodesUsed = 0;
  let explorationSkipped = 0;

  for (let it = 0; it < iterations; it++) {
    const totalGrad = new Array(FEATURE_DIM).fill(0);
    let localGroups = 0;
    let localEps = 0;
    let localSkipped = 0;

    for (const [, bucket] of groups) {
      const trainable = bucket.filter((e) => !e.exploration);
      localSkipped += bucket.length - trainable.length;
      if (trainable.length === 0) continue;

      const rewards = trainable.map((e) => e.r);
      const advantages = computeAdvantages(rewards);

      for (let i = 0; i < trainable.length; i++) {
        const ep = trainable[i];
        const grad = logisticGradient(theta, ep.x, ep.label, advantages[i]);
        for (let k = 0; k < FEATURE_DIM; k++) {
          totalGrad[k] += grad[k];
        }
        localEps++;
      }
      localGroups++;
    }

    const shrinkage = klShrinkage(theta, baseTheta, lambda);
    for (let k = 0; k < FEATURE_DIM; k++) {
      theta[k] = theta[k] + lr * totalGrad[k] - shrinkage[k];
    }
    theta = clipTheta(theta);

    if (it === iterations - 1) {
      groupsUsed = localGroups;
      episodesUsed = localEps;
      explorationSkipped = localSkipped;
    }
  }

  return { theta, groupsUsed, episodesUsed, explorationSkipped };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a policy on held-out episodes.
 *   - logLoss: cross-entropy vs S2/S1 decision
 *   - accuracyVsHeuristic: fraction of episodes where predicted decision
 *     matches the episode's actual system (the baseline heuristic decision)
 *   - klFromPrev: L2 divergence from `thetaPrev`
 *
 * @param {number[]} theta
 * @param {object[]} heldOut
 * @param {number[]} [thetaPrev]
 * @returns {{ logLoss: number, accuracyVsHeuristic: number, klFromPrev: number, samples: number }}
 */
export function evaluatePolicy(theta, heldOut, thetaPrev) {
  const samples = (heldOut ?? [])
    .map((e) => normalizeEpisode(e))
    .filter((e) => e !== null);

  if (samples.length === 0) {
    return { logLoss: 0, accuracyVsHeuristic: 0, klFromPrev: thetaPrev ? klFromPrev(theta, thetaPrev) : 0, samples: 0 };
  }

  let lossSum = 0;
  let correct = 0;
  const eps = 1e-9;
  for (const s of samples) {
    const p = predict(theta, s.x);
    const pClamped = Math.max(eps, Math.min(1 - eps, p));
    const y = s.label;
    lossSum += -(y * Math.log(pClamped) + (1 - y) * Math.log(1 - pClamped));
    const decision = p > 0.5 ? 1 : 0;
    if (decision === y) correct++;
  }

  const kl = thetaPrev ? klFromPrev(theta, thetaPrev) : 0;
  return {
    logLoss: lossSum / samples.length,
    accuracyVsHeuristic: correct / samples.length,
    klFromPrev: kl,
    samples: samples.length,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical policy directory. Honors `policyPath` override
 * (absolute path to the JSON file); otherwise uses `~/.claude/artibot/policies/`.
 *
 * @param {string} [policyPath]
 * @returns {{ policyFile: string, snapshotDir: string }}
 */
export function resolvePolicyPaths(policyPath) {
  const file = policyPath && path.isAbsolute(policyPath)
    ? policyPath
    : path.join(getHomeDir(), '.claude', 'artibot', 'policies', 'routing-policy-v1.json');
  const dir = path.dirname(file);
  return { policyFile: file, snapshotDir: path.join(dir, 'snapshots') };
}

function makeSnapshotId(now = new Date()) {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `v${POLICY_VERSION}-${iso}-${rand}`;
}

/**
 * Load the current policy from disk. Returns `null` when the file does not
 * exist or is malformed. Never throws.
 *
 * @param {string} [policyPath]
 * @returns {Promise<object|null>}
 */
export async function loadPolicy(policyPath) {
  const { policyFile } = resolvePolicyPaths(policyPath);
  const data = await readJsonFile(policyFile);
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.theta) || data.theta.length !== FEATURE_DIM) return null;
  return data;
}

/**
 * Atomic-ish write of policy record + rotating snapshot.
 * Keeps the newest `snapshotCount` snapshots, prunes the rest.
 *
 * @param {number[]} theta
 * @param {object} metrics
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {number} [options.trainedOnEpisodes]
 * @param {string} [options.previousSnapshotId]
 * @param {number} [options.snapshotCount=DEFAULTS.snapshotCount]
 * @returns {Promise<{ policy: object, snapshotId: string, policyFile: string }>}
 */
export async function savePolicy(theta, metrics, options = {}) {
  const { policyFile, snapshotDir } = resolvePolicyPaths(options.policyPath);
  const snapshotCount = options.snapshotCount ?? DEFAULTS.snapshotCount;

  await ensureDir(path.dirname(policyFile));
  await ensureDir(snapshotDir);

  const snapshotId = makeSnapshotId();
  const policy = {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    features: [...FEATURE_NAMES],
    theta: [...theta],
    trainedAt: new Date().toISOString(),
    trainedOnEpisodes: options.trainedOnEpisodes ?? 0,
    metrics: {
      logLoss: round6(metrics?.logLoss ?? 0),
      accuracyVsHeuristic: round6(metrics?.accuracyVsHeuristic ?? 0),
      klFromPrev: round6(metrics?.klFromPrev ?? 0),
    },
    previousSnapshotId: options.previousSnapshotId ?? null,
    snapshotId,
  };

  await writeJsonFile(policyFile, policy);
  await writeJsonFile(path.join(snapshotDir, `${snapshotId}.json`), policy);
  await pruneSnapshots(snapshotDir, snapshotCount);

  return { policy, snapshotId, policyFile };
}

/**
 * Write a standalone snapshot of `theta` to `snapshotDir` with id `id`.
 * Useful for rollback fixtures and tests.
 *
 * @param {number[]} theta
 * @param {string} id
 * @param {string} [policyPath]
 * @returns {Promise<string>} absolute snapshot file path
 */
export async function snapshot(theta, id, policyPath) {
  const { snapshotDir } = resolvePolicyPaths(policyPath);
  await ensureDir(snapshotDir);
  const file = path.join(snapshotDir, `${id}.json`);
  await writeJsonFile(file, {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    features: [...FEATURE_NAMES],
    theta: [...theta],
    trainedAt: new Date().toISOString(),
    snapshotId: id,
  });
  return file;
}

/**
 * List snapshot records sorted newest-first. Malformed files are skipped.
 *
 * @param {string} [policyPath]
 * @returns {Promise<{ id: string, file: string, trainedAt: string, theta: number[] }[]>}
 */
export async function listSnapshots(policyPath) {
  const { snapshotDir } = resolvePolicyPaths(policyPath);
  const fs = await import('node:fs/promises');
  let entries;
  try {
    entries = await fs.readdir(snapshotDir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(snapshotDir, name);
    const data = await readJsonFile(file);
    if (!data || !Array.isArray(data.theta) || data.theta.length !== FEATURE_DIM) continue;
    records.push({
      id: data.snapshotId ?? name.replace(/\.json$/, ''),
      file,
      trainedAt: data.trainedAt ?? '',
      theta: data.theta,
    });
  }
  records.sort((a, b) => (b.trainedAt || '').localeCompare(a.trainedAt || ''));
  return records;
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
    } catch {
      // skip
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const toDelete = files.slice(Math.max(0, retain));
  for (const f of toDelete) {
    try {
      await fs.unlink(f.full);
    } catch {
      // best-effort
    }
  }
}

function round6(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// High-level facade
// ---------------------------------------------------------------------------

/**
 * Create a stateful policy-updater scoped to a policy file.
 *
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {object[]} [options.history] - pre-loaded episode history (ignored
 *   in favor of `trainFromEpisodes` argument; accepted for API symmetry).
 * @param {object} [options.config] - routing policy config block
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]
 * @returns {{
 *   loadPolicy: () => Promise<object|null>,
 *   trainFromEpisodes: (episodes: object[], heldOut?: object[]) =>
 *     Promise<{ policy: object|null, metrics: object, rejected?: string }>,
 *   listSnapshots: () => Promise<ReturnType<typeof listSnapshots> extends Promise<infer T> ? T : never>,
 *   rollback: (n?: number) => Promise<object|null>,
 * }}
 */
export function createPolicyUpdater(options = {}) {
  const policyPath = options.policyPath;
  const config = { ...DEFAULTS, ...(options.config ?? {}) };
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };

  return {
    loadPolicy: () => loadPolicy(policyPath),

    async trainFromEpisodes(episodes, heldOut) {
      const prev = await loadPolicy(policyPath);
      const thetaPrev = prev?.theta ?? new Array(FEATURE_DIM).fill(0);
      const hasPrev = Boolean(prev);

      let theta;
      let usedEpisodes = 0;
      let coldStart = false;

      if (!hasPrev) {
        const warm = coldStartWarmup(episodes, {
          minEpisodes: config.coldStartEpisodes,
          iterations: config.warmupIterations,
          learningRate: config.warmupLearningRate,
        });
        if (!warm) {
          logger.info('cold-start deferred: insufficient episodes');
          return { policy: null, metrics: { reason: 'cold-start-insufficient' } };
        }
        theta = warm.theta;
        usedEpisodes = warm.episodesUsed;
        coldStart = true;
      } else {
        const res = trainBatch(episodes, thetaPrev, {
          learningRate: config.learningRate,
          klPenalty: config.klPenalty,
        });
        theta = res.theta;
        usedEpisodes = res.episodesUsed;
      }

      const holdout = heldOut && heldOut.length > 0 ? heldOut : episodes;
      const metrics = evaluatePolicy(theta, holdout, thetaPrev);

      if (!coldStart && metrics.klFromPrev > config.klRejectThreshold) {
        logger.warn(`policy update rejected: KL ${metrics.klFromPrev.toFixed(4)} > ${config.klRejectThreshold}`);
        return { policy: prev, metrics, rejected: 'kl-threshold' };
      }

      const saved = await savePolicy(theta, metrics, {
        policyPath,
        trainedOnEpisodes: usedEpisodes,
        previousSnapshotId: prev?.snapshotId ?? null,
        snapshotCount: config.snapshotCount,
      });

      return { policy: saved.policy, metrics, coldStart };
    },

    listSnapshots: () => listSnapshots(policyPath),

    async rollback(n = 1) {
      const snapshots = await listSnapshots(policyPath);
      const idx = Math.max(0, Math.min(snapshots.length - 1, n));
      const target = snapshots[idx];
      if (!target) return null;
      const { policyFile } = resolvePolicyPaths(policyPath);
      await writeJsonFile(policyFile, {
        version: POLICY_VERSION,
        modelType: MODEL_TYPE,
        features: [...FEATURE_NAMES],
        theta: [...target.theta],
        trainedAt: new Date().toISOString(),
        rolledBackFrom: snapshots[0]?.id ?? null,
        rolledBackTo: target.id,
        snapshotId: target.id,
      });
      return { rolledBackTo: target.id, theta: target.theta };
    },
  };
}
