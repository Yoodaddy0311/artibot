/**
 * GRPO-RLVR Neural Policy (v3.6 — opt-in MLP upgrade path for v3.4 linear).
 *
 * Interface-compatible replacement for `policy-updater.js`'s linear/logistic
 * routing policy. Same feature vector (d=9), same GRPO group-relative
 * advantage, same KL penalty semantics — but p(S2 | x) is computed by a
 * tiny 2-layer MLP (9 → 16 → 1 sigmoid) with hand-rolled matrix ops and
 * chain-rule backprop. Zero external deps.
 *
 * θ structure (JSON-serialisable):
 *   {
 *     W1: number[HIDDEN_DIM][FEATURE_DIM],   // hidden layer weights
 *     b1: number[HIDDEN_DIM],                // hidden layer biases
 *     W2: number[1][HIDDEN_DIM],             // output layer weights (row)
 *     b2: number[1],                         // output layer bias
 *   }
 *
 * Math:
 *   z1 = W1 · x + b1              (shape HIDDEN)
 *   a1 = ReLU(z1)                 (shape HIDDEN)
 *   z2 = W2 · a1 + b2             (scalar)
 *   p  = sigmoid(z2)              (scalar in (0,1))
 *
 * GRPO gradient (scaled by group-relative advantage):
 *   dL/dz2 = advantage * (label - p)     (positive = push up when label=1)
 *   dL/dW2 = dz2 * a1^T
 *   dL/db2 = dz2
 *   dL/da1 = W2^T * dz2
 *   dL/dz1 = dL/da1 * ReLU'(z1)
 *   dL/dW1 = dz1 * x^T
 *   dL/db1 = dz1
 *
 * KL-proxy: L2 distance between θ and θ_prev, computed per-parameter group.
 * Gradient clipping: each weight matrix's Frobenius (L2) norm capped at 5.
 *
 * Zero runtime deps, deterministic under NODE_ENV=test, no network IO.
 * See `_design/grpo-rlvr-routing-2026-04-24.md` Section 11 N4 for rationale.
 *
 * @module lib/learning/grpo/neural-policy
 */

import path from 'node:path';
import { ensureDir, readJsonFile, writeJsonFile } from '../../core/file.js';
import { getHomeDir } from '../../core/platform.js';
import { FEATURE_DIM, FEATURE_NAMES } from './policy-updater.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hidden layer width. Small enough that forward pass remains ~few us. */
export const HIDDEN_DIM = 16;

/** Model type identifier for on-disk schema; distinguishes from `logistic-regression`. */
export const MODEL_TYPE = 'mlp';

/** Training defaults — mirror `learning.grpoRouting.*` but tuned for MLP capacity. */
export const NEURAL_DEFAULTS = Object.freeze({
  learningRate: 0.02,
  klPenalty: 0.01,
  gradClipNorm: 5,
  sigmoidClamp: 40,
  initScale: 0.1,           // He/Xavier-lite init
  snapshotCount: 3,
  klRejectThreshold: 0.5,
  maxBatchIterations: 30,
});

const POLICY_VERSION = 1;

// ---------------------------------------------------------------------------
// Matrix / vector primitives (hand-rolled, zero-dep)
// ---------------------------------------------------------------------------

/**
 * Numerically stable sigmoid with clamped input to avoid overflow.
 * @param {number} z
 * @returns {number} in (0, 1)
 */
export function sigmoid(z) {
  const c = NEURAL_DEFAULTS.sigmoidClamp;
  let zc = z;
  if (zc > c) zc = c;
  if (zc < -c) zc = -c;
  if (zc >= 0) {
    const ez = Math.exp(-zc);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(zc);
  return ez / (1 + ez);
}

/**
 * ReLU activation; returns max(0, z).
 * @param {number} z
 * @returns {number}
 */
export function relu(z) {
  return z > 0 ? z : 0;
}

/**
 * Matrix-vector multiply: `m` is `rows × cols`, `v` is length `cols`.
 * Length mismatch → zero-filled output (never throws).
 *
 * @param {number[][]} m
 * @param {number[]} v
 * @returns {number[]} length `rows`
 */
export function matVec(m, v) {
  if (!Array.isArray(m) || !Array.isArray(v)) return [];
  const rows = m.length;
  const out = new Array(rows);
  for (let i = 0; i < rows; i++) {
    const row = m[i];
    if (!Array.isArray(row) || row.length !== v.length) {
      out[i] = 0;
      continue;
    }
    let s = 0;
    for (let j = 0; j < row.length; j++) {
      s += (row[j] ?? 0) * (v[j] ?? 0);
    }
    out[i] = s;
  }
  return out;
}

/**
 * Vector addition: `a + b`. Length mismatch → copy of `a`.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]}
 */
export function vecAdd(a, b) {
  if (!Array.isArray(a)) return [];
  if (!Array.isArray(b) || a.length !== b.length) return [...a];
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/**
 * Element-wise vector ReLU.
 * @param {number[]} v
 * @returns {number[]}
 */
export function vecRelu(v) {
  if (!Array.isArray(v)) return [];
  return v.map(relu);
}

/**
 * Frobenius norm of a matrix (sqrt of sum of squares).
 * @param {number[][]} m
 * @returns {number}
 */
export function frobeniusNorm(m) {
  if (!Array.isArray(m)) return 0;
  let s = 0;
  for (const row of m) {
    if (!Array.isArray(row)) continue;
    for (const v of row) {
      const vv = typeof v === 'number' && Number.isFinite(v) ? v : 0;
      s += vv * vv;
    }
  }
  return Math.sqrt(s);
}

/**
 * Scale every entry of a matrix by `factor`.
 * @param {number[][]} m
 * @param {number} factor
 * @returns {number[][]}
 */
export function matScale(m, factor) {
  if (!Array.isArray(m)) return [];
  return m.map((row) =>
    Array.isArray(row) ? row.map((v) => (Number.isFinite(v) ? v * factor : 0)) : [],
  );
}

/**
 * Clip a weight matrix's Frobenius norm to `maxNorm`. No-op if already within.
 *
 * @param {number[][]} m
 * @param {number} maxNorm
 * @returns {number[][]}
 */
export function clipMatrixNorm(m, maxNorm = NEURAL_DEFAULTS.gradClipNorm) {
  const n = frobeniusNorm(m);
  if (n <= maxNorm || n === 0) return m.map((r) => [...r]);
  return matScale(m, maxNorm / n);
}

// ---------------------------------------------------------------------------
// Theta lifecycle
// ---------------------------------------------------------------------------

/**
 * Deterministic pseudo-random init seeded by `seed` (xorshift). Values in
 * `[-initScale, +initScale]`. When seed is omitted we fall back to `Math.random`,
 * but production call-sites should pass a seed for reproducibility.
 *
 * @param {number} [seed=1]
 * @returns {() => number}
 */
export function makeRng(seed = 1) {
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // map int32 → (-1, 1)
    return (s / 0x80000000);
  };
}

/**
 * Create a fresh θ with small random weights. Biases start at 0.
 *
 * @param {object} [options]
 * @param {number} [options.seed=1]
 * @param {number} [options.initScale=NEURAL_DEFAULTS.initScale]
 * @returns {{ W1: number[][], b1: number[], W2: number[][], b2: number[] }}
 */
export function createTheta(options = {}) {
  const rng = makeRng(options.seed ?? 1);
  const scale = options.initScale ?? NEURAL_DEFAULTS.initScale;
  const W1 = new Array(HIDDEN_DIM);
  for (let i = 0; i < HIDDEN_DIM; i++) {
    const row = new Array(FEATURE_DIM);
    for (let j = 0; j < FEATURE_DIM; j++) row[j] = rng() * scale;
    W1[i] = row;
  }
  const W2row = new Array(HIDDEN_DIM);
  for (let j = 0; j < HIDDEN_DIM; j++) W2row[j] = rng() * scale;
  return {
    W1,
    b1: new Array(HIDDEN_DIM).fill(0),
    W2: [W2row],
    b2: [0],
  };
}

/**
 * Shape-check a θ candidate; return true when dimensions match the MLP.
 * @param {unknown} theta
 * @returns {boolean}
 */
export function isValidTheta(theta) {
  if (!theta || typeof theta !== 'object') return false;
  const t = /** @type {any} */ (theta);
  if (!Array.isArray(t.W1) || t.W1.length !== HIDDEN_DIM) return false;
  for (const row of t.W1) {
    if (!Array.isArray(row) || row.length !== FEATURE_DIM) return false;
  }
  if (!Array.isArray(t.b1) || t.b1.length !== HIDDEN_DIM) return false;
  if (!Array.isArray(t.W2) || t.W2.length !== 1) return false;
  if (!Array.isArray(t.W2[0]) || t.W2[0].length !== HIDDEN_DIM) return false;
  if (!Array.isArray(t.b2) || t.b2.length !== 1) return false;
  return true;
}

/**
 * Deep-copy θ so training step produces a new record (immutable pattern).
 * @param {object} theta
 * @returns {object}
 */
export function cloneTheta(theta) {
  return {
    W1: theta.W1.map((r) => [...r]),
    b1: [...theta.b1],
    W2: theta.W2.map((r) => [...r]),
    b2: [...theta.b2],
  };
}

// ---------------------------------------------------------------------------
// Forward / backward
// ---------------------------------------------------------------------------

/**
 * Forward pass. Returns the cached activations needed for backprop.
 *
 * @param {object} theta
 * @param {number[]} x
 * @returns {{ z1: number[], a1: number[], z2: number, p: number }}
 */
export function forward(theta, x) {
  const z1 = vecAdd(matVec(theta.W1, x), theta.b1);
  const a1 = vecRelu(z1);
  const z2 = matVec(theta.W2, a1)[0] + (theta.b2[0] ?? 0);
  const p = sigmoid(z2);
  return { z1, a1, z2, p };
}

/**
 * Public prediction — returns only the sigmoid probability.
 *
 * @param {object} theta
 * @param {number[]} x
 * @returns {number} p(S2 | x)
 */
export function predict(theta, x) {
  return forward(theta, x).p;
}

/**
 * Backward pass for a single example, producing per-parameter gradients.
 * `residualScale = advantage * (label - p)` mirrors the logistic-regression
 * GRPO update. Returned gradients are ready to be ADDED to accumulators.
 *
 * @param {object} theta
 * @param {number[]} x
 * @param {{ z1: number[], a1: number[], p: number }} cache
 * @param {0|1} label
 * @param {number} advantage
 * @returns {{ dW1: number[][], db1: number[], dW2: number[][], db2: number[] }}
 */
export function backward(theta, x, cache, label, advantage) {
  // In GRPO we ASCEND the log-likelihood scaled by advantage, so the sign
  // convention matches policy-updater.js: `grad ∝ advantage * (label - p)`.
  const dz2 = advantage * (label - cache.p);

  // Output layer grads
  const dW2row = new Array(HIDDEN_DIM);
  for (let j = 0; j < HIDDEN_DIM; j++) dW2row[j] = dz2 * (cache.a1[j] ?? 0);
  const dW2 = [dW2row];
  const db2 = [dz2];

  // Propagate through output: dL/da1 = W2^T * dz2  (W2 is 1×HIDDEN)
  const da1 = new Array(HIDDEN_DIM);
  for (let j = 0; j < HIDDEN_DIM; j++) da1[j] = (theta.W2[0][j] ?? 0) * dz2;

  // dL/dz1 = da1 * ReLU'(z1)
  const dz1 = new Array(HIDDEN_DIM);
  for (let i = 0; i < HIDDEN_DIM; i++) dz1[i] = cache.z1[i] > 0 ? da1[i] : 0;

  // dL/dW1 = dz1 · x^T  (outer product, HIDDEN × FEATURE)
  const dW1 = new Array(HIDDEN_DIM);
  for (let i = 0; i < HIDDEN_DIM; i++) {
    const row = new Array(FEATURE_DIM);
    for (let j = 0; j < FEATURE_DIM; j++) row[j] = dz1[i] * (x[j] ?? 0);
    dW1[i] = row;
  }
  return { dW1, db1: [...dz1], dW2, db2 };
}

// ---------------------------------------------------------------------------
// Episode helpers (mirror policy-updater for interface compat)
// ---------------------------------------------------------------------------

/**
 * Import the linear policy's episode normalizer so neural callers need not
 * know the feature-building details. Re-export lazily to avoid circular deps.
 */
export async function normalizeEpisode(episode) {
  const mod = await import('./policy-updater.js');
  return mod.normalizeEpisode(episode);
}

/**
 * Group-relative advantage: `(r - mean) / std`, epsilon-guarded.
 *
 * @param {number[]} rewards
 * @returns {number[]}
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
  const std = Math.sqrt(sqSum / n);
  const denom = std > 1e-6 ? std : 1;
  return rewards.map((r) => (r - mean) / denom);
}

// ---------------------------------------------------------------------------
// KL proxy (per-parameter-group L2)
// ---------------------------------------------------------------------------

/**
 * L2 divergence between two θ checkpoints, summed over all 4 parameter
 * groups. Acts as a stand-in for KL divergence (same role as in
 * policy-updater.klFromPrev).
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function klFromPrev(a, b) {
  if (!isValidTheta(a) || !isValidTheta(b)) return 0;
  let s = 0;
  for (let i = 0; i < HIDDEN_DIM; i++) {
    for (let j = 0; j < FEATURE_DIM; j++) {
      const d = (a.W1[i][j] ?? 0) - (b.W1[i][j] ?? 0);
      s += d * d;
    }
    const d1 = (a.b1[i] ?? 0) - (b.b1[i] ?? 0);
    s += d1 * d1;
    const d2 = (a.W2[0][i] ?? 0) - (b.W2[0][i] ?? 0);
    s += d2 * d2;
  }
  const db2 = (a.b2[0] ?? 0) - (b.b2[0] ?? 0);
  s += db2 * db2;
  return s;
}

// ---------------------------------------------------------------------------
// Batch trainer
// ---------------------------------------------------------------------------

/**
 * Train the MLP on a batch of episodes. Mirrors `policy-updater.trainBatch`:
 * group by intent-family, compute rank-advantage per group, accumulate
 * gradients, apply KL shrinkage toward `thetaPrev`, clip each matrix's
 * Frobenius norm to `gradClipNorm`.
 *
 * Exploration-flagged episodes are excluded from the gradient update.
 *
 * @param {object[]} episodes
 * @param {object} thetaPrev - previous θ (same shape as MLP)
 * @param {object} [options]
 * @param {number} [options.learningRate=NEURAL_DEFAULTS.learningRate]
 * @param {number} [options.klPenalty=NEURAL_DEFAULTS.klPenalty]
 * @param {number} [options.iterations=1]
 * @param {number} [options.gradClipNorm=NEURAL_DEFAULTS.gradClipNorm]
 * @returns {Promise<{
 *   theta: object,
 *   groupsUsed: number,
 *   episodesUsed: number,
 *   explorationSkipped: number,
 * }>}
 */
export async function trainBatch(episodes, thetaPrev, options = {}) {
  const lr = options.learningRate ?? NEURAL_DEFAULTS.learningRate;
  const lambda = options.klPenalty ?? NEURAL_DEFAULTS.klPenalty;
  const clipNorm = options.gradClipNorm ?? NEURAL_DEFAULTS.gradClipNorm;
  const iterations = Math.max(
    1,
    Math.min(NEURAL_DEFAULTS.maxBatchIterations, options.iterations ?? 1),
  );

  const baseTheta = isValidTheta(thetaPrev) ? cloneTheta(thetaPrev) : createTheta();
  const { normalizeEpisode: ne } = await import('./policy-updater.js');
  const groups = bucketByGroup(episodes, ne);

  const theta = cloneTheta(baseTheta);
  let stats = { groupsUsed: 0, episodesUsed: 0, explorationSkipped: 0 };
  for (let it = 0; it < iterations; it++) {
    stats = runIteration(theta, groups, baseTheta, lr, lambda, clipNorm);
  }
  return { theta, ...stats };
}

/** Normalise + group episodes by intent-family. */
function bucketByGroup(episodes, ne) {
  const groups = new Map();
  for (const raw of episodes ?? []) {
    const n = ne(raw);
    if (!n) continue;
    const bucket = groups.get(n.group) ?? [];
    bucket.push(n);
    groups.set(n.group, bucket);
  }
  return groups;
}

/**
 * Run one gradient step across all groups and apply the update.
 * @returns {{ groupsUsed: number, episodesUsed: number, explorationSkipped: number }}
 */
function runIteration(theta, groups, baseTheta, lr, lambda, clipNorm) {
  const acc = zeroGrad();
  let gUsed = 0;
  let eUsed = 0;
  let skipped = 0;
  for (const [, bucket] of groups) {
    const trainable = bucket.filter((e) => !e.exploration);
    skipped += bucket.length - trainable.length;
    if (trainable.length === 0) continue;
    const advantages = computeAdvantages(trainable.map((e) => e.r));
    for (let i = 0; i < trainable.length; i++) {
      const ep = trainable[i];
      const cache = forward(theta, ep.x);
      addGrad(acc, backward(theta, ep.x, cache, ep.label, advantages[i]));
      eUsed++;
    }
    gUsed++;
  }
  applyUpdate(theta, acc, baseTheta, lr, lambda, clipNorm);
  return { groupsUsed: gUsed, episodesUsed: eUsed, explorationSkipped: skipped };
}

function zeroGrad() {
  return {
    dW1: Array.from({ length: HIDDEN_DIM }, () => new Array(FEATURE_DIM).fill(0)),
    db1: new Array(HIDDEN_DIM).fill(0),
    dW2: [new Array(HIDDEN_DIM).fill(0)],
    db2: [0],
  };
}

function addGrad(acc, g) {
  for (let i = 0; i < HIDDEN_DIM; i++) {
    for (let j = 0; j < FEATURE_DIM; j++) acc.dW1[i][j] += g.dW1[i][j];
    acc.db1[i] += g.db1[i];
    acc.dW2[0][i] += g.dW2[0][i];
  }
  acc.db2[0] += g.db2[0];
}

/**
 * Apply one gradient step to θ in-place: `θ += lr*grad - λ*(θ - θ_prev)`.
 * Weight matrices are clipped to `clipNorm` Frobenius norm AFTER the step.
 *
 * @param {object} theta
 * @param {object} acc
 * @param {object} thetaPrev
 * @param {number} lr
 * @param {number} lambda
 * @param {number} clipNorm
 */
export function applyUpdate(theta, acc, thetaPrev, lr, lambda, clipNorm) {
  for (let i = 0; i < HIDDEN_DIM; i++) {
    for (let j = 0; j < FEATURE_DIM; j++) {
      const shrink = lambda * (theta.W1[i][j] - thetaPrev.W1[i][j]);
      theta.W1[i][j] = theta.W1[i][j] + lr * acc.dW1[i][j] - shrink;
    }
    const sb1 = lambda * (theta.b1[i] - thetaPrev.b1[i]);
    theta.b1[i] = theta.b1[i] + lr * acc.db1[i] - sb1;
    const sW2 = lambda * (theta.W2[0][i] - thetaPrev.W2[0][i]);
    theta.W2[0][i] = theta.W2[0][i] + lr * acc.dW2[0][i] - sW2;
  }
  const sb2 = lambda * (theta.b2[0] - thetaPrev.b2[0]);
  theta.b2[0] = theta.b2[0] + lr * acc.db2[0] - sb2;

  theta.W1 = clipMatrixNorm(theta.W1, clipNorm);
  theta.W2 = clipMatrixNorm(theta.W2, clipNorm);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate θ on held-out episodes. Returns log-loss, accuracy vs. the
 * heuristic baseline (episode.classification.system), and KL proxy.
 *
 * @param {object} theta
 * @param {object[]} heldOut
 * @param {object} [thetaPrev]
 * @returns {Promise<{ logLoss: number, accuracyVsHeuristic: number, klFromPrev: number, samples: number }>}
 */
export async function evaluatePolicy(theta, heldOut, thetaPrev) {
  const { normalizeEpisode: ne } = await import('./policy-updater.js');
  const samples = [];
  for (const raw of heldOut ?? []) {
    const n = ne(raw);
    if (n) samples.push(n);
  }
  if (samples.length === 0) {
    return {
      logLoss: 0,
      accuracyVsHeuristic: 0,
      klFromPrev: thetaPrev ? klFromPrev(theta, thetaPrev) : 0,
      samples: 0,
    };
  }
  let lossSum = 0;
  let correct = 0;
  const eps = 1e-9;
  for (const s of samples) {
    const p = predict(theta, s.x);
    const pC = Math.max(eps, Math.min(1 - eps, p));
    const y = s.label;
    lossSum += -(y * Math.log(pC) + (1 - y) * Math.log(1 - pC));
    const decision = p > 0.5 ? 1 : 0;
    if (decision === y) correct++;
  }
  return {
    logLoss: lossSum / samples.length,
    accuracyVsHeuristic: correct / samples.length,
    klFromPrev: thetaPrev ? klFromPrev(theta, thetaPrev) : 0,
    samples: samples.length,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Canonical on-disk location for the neural policy file. Kept distinct
 * from the linear policy so both can coexist during migration.
 *
 * @param {string} [policyPath]
 * @returns {{ policyFile: string, snapshotDir: string }}
 */
export function resolvePolicyPaths(policyPath) {
  const file = policyPath && path.isAbsolute(policyPath)
    ? policyPath
    : path.join(getHomeDir(), '.claude', 'artibot', 'policies', 'routing-policy-mlp-v1.json');
  const dir = path.dirname(file);
  return { policyFile: file, snapshotDir: path.join(dir, 'snapshots') };
}

/**
 * Load the neural policy record. Returns null if missing, malformed, or the
 * stored modelType is not `mlp` (the caller can then decide to fall back to
 * the linear policy).
 *
 * @param {string} [policyPath]
 * @returns {Promise<object|null>}
 */
export async function loadPolicy(policyPath) {
  const { policyFile } = resolvePolicyPaths(policyPath);
  const data = await readJsonFile(policyFile);
  if (!data || typeof data !== 'object') return null;
  if (data.modelType !== MODEL_TYPE) return null;
  if (!isValidTheta(data.theta)) return null;
  return data;
}

function makeSnapshotId(now = new Date()) {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `mlp-v${POLICY_VERSION}-${iso}-${rand}`;
}

/**
 * Save θ atomically with a rotating snapshot. Matches the persistence
 * contract used by `policy-updater.savePolicy` (same snapshot retention).
 *
 * @param {object} theta
 * @param {object} metrics
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {number} [options.trainedOnEpisodes]
 * @param {string} [options.previousSnapshotId]
 * @param {number} [options.snapshotCount=NEURAL_DEFAULTS.snapshotCount]
 * @returns {Promise<{ policy: object, snapshotId: string, policyFile: string }>}
 */
export async function savePolicy(theta, metrics, options = {}) {
  const { policyFile, snapshotDir } = resolvePolicyPaths(options.policyPath);
  const snapshotCount = options.snapshotCount ?? NEURAL_DEFAULTS.snapshotCount;
  await ensureDir(path.dirname(policyFile));
  await ensureDir(snapshotDir);

  const snapshotId = makeSnapshotId();
  const policy = {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    features: [...FEATURE_NAMES],
    hiddenDim: HIDDEN_DIM,
    theta: cloneTheta(theta),
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
  const toDelete = files.slice(Math.max(0, retain));
  for (const f of toDelete) {
    try { await fs.unlink(f.full); } catch { /* best-effort */ }
  }
}

function round6(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// High-level facade (mirrors createPolicyUpdater)
// ---------------------------------------------------------------------------

/**
 * Create a stateful neural policy updater. Interface-compatible with
 * `createPolicyUpdater` from policy-updater.js (same method shapes) but
 * operates on MLP weights. When the stored policy is absent or has the
 * wrong modelType, cold-start initialises a fresh θ instead of running
 * supervised warmup (MLP training needs many more episodes to stabilise;
 * we rely on KL to the random init for the first batch).
 *
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {object} [options.config]
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]
 * @returns {{
 *   loadPolicy: () => Promise<object|null>,
 *   trainFromEpisodes: (episodes: object[], heldOut?: object[]) => Promise<object>,
 * }}
 */
export function createNeuralPolicy(options = {}) {
  const policyPath = options.policyPath;
  const config = { ...NEURAL_DEFAULTS, ...(options.config ?? {}) };
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };

  return {
    loadPolicy: () => loadPolicy(policyPath),

    async trainFromEpisodes(episodes, heldOut) {
      const prev = await loadPolicy(policyPath);
      const thetaPrev = prev?.theta && isValidTheta(prev.theta)
        ? prev.theta
        : createTheta({ seed: 1 });
      const hasPrev = Boolean(prev);

      const res = await trainBatch(episodes, thetaPrev, {
        learningRate: config.learningRate,
        klPenalty: config.klPenalty,
        gradClipNorm: config.gradClipNorm,
      });

      const holdout = heldOut && heldOut.length > 0 ? heldOut : episodes;
      const metrics = await evaluatePolicy(res.theta, holdout, thetaPrev);

      if (hasPrev && metrics.klFromPrev > config.klRejectThreshold) {
        logger.warn(`neural policy update rejected: KL ${metrics.klFromPrev.toFixed(4)} > ${config.klRejectThreshold}`);
        return { policy: prev, metrics, rejected: 'kl-threshold' };
      }

      const saved = await savePolicy(res.theta, metrics, {
        policyPath,
        trainedOnEpisodes: res.episodesUsed,
        previousSnapshotId: prev?.snapshotId ?? null,
        snapshotCount: config.snapshotCount,
      });
      return { policy: saved.policy, metrics, coldStart: !hasPrev };
    },
  };
}
