/**
 * GRPO-RLVR Agent-Selection Policy (v3.5, Section 5.4 of routing design).
 *
 * Extends the routing GRPO framework to **agent selection**: given a
 * `task_family` and context, pick an agent from a candidate set using a
 * softmax distribution over learned per-agent weights. Trained nightly from
 * verifiable-reward episodes grouped by task family, using the same group-
 * relative advantage + policy-gradient recipe as the routing policy.
 *
 * Key differences from `policy-updater.js` (routing):
 *   - Output space is a **distribution over agents**, not a binary S1/S2 probability.
 *   - Weights are organized as `weights[taskFamily][agentName] = scalar` so
 *     each task family maintains an independent softmax head. Stepwise updates
 *     only touch the head of the observed family (isolation).
 *   - Gradient is the classic softmax cross-entropy form:
 *         grad_a = advantage * (1[a=chosen] - pi(a|f))
 *     scaled by reward advantage over the group. No feature vector — action
 *     selection is family-conditional only.
 *   - Fallback to `artibot.config.json` `agents.taskBased` map until a family
 *     has >=3 trained episodes (baseline continuity).
 *
 * Persistence lives in `agent-policy-store.js` to keep this file within the
 * 800-line quality gate.
 *
 * Zero external deps. Deterministic under `NODE_ENV=test`. No network IO.
 *
 * See `_design/grpo-rlvr-routing-2026-04-24.md` Section 5.4 + Section 3.4.
 *
 * @module lib/learning/grpo/agent-policy
 */

import {
  loadPolicy,
  savePolicy,
  snapshot,
  listSnapshots,
  resolvePolicyPaths,
  writeRolledBackPolicy,
} from './agent-policy-store.js';

// Re-export persistence surface for external consumers (tests, bridge).
export { loadPolicy, savePolicy, snapshot, listSnapshots, resolvePolicyPaths };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Training defaults — conservative; callers override via `config`. */
export const DEFAULTS = Object.freeze({
  learningRate: 0.05,
  klPenalty: 0.01,
  clipRange: 5,
  coldStartEpisodes: 30,          // per-family (much lower than routing's 200)
  snapshotCount: 3,
  klRejectThreshold: 0.25,
  temperature: 1.0,
  minFamilyOccurrences: 3,        // baseline fallback threshold
  maxBatchIterations: 10,
});

// ---------------------------------------------------------------------------
// Math primitives
// ---------------------------------------------------------------------------

/**
 * Numerically stable softmax over a weight vector with optional temperature.
 * Higher temperature -> flatter distribution; lower -> sharper.
 *
 * @param {number[]} weights
 * @param {number} [temperature=1.0]
 * @returns {number[]} probabilities summing to 1
 */
export function softmax(weights, temperature = 1.0) {
  if (!Array.isArray(weights) || weights.length === 0) return [];
  const t = Number.isFinite(temperature) && temperature > 0 ? temperature : 1.0;
  const scaled = weights.map((w) => {
    const n = typeof w === 'number' && Number.isFinite(w) ? w : 0;
    return n / t;
  });
  let max = -Infinity;
  for (const v of scaled) if (v > max) max = v;
  if (!Number.isFinite(max)) max = 0;
  let sum = 0;
  const exp = scaled.map((v) => {
    const e = Math.exp(v - max);
    sum += e;
    return e;
  });
  if (sum <= 0) return exp.map(() => 1 / exp.length);
  return exp.map((e) => e / sum);
}

/**
 * Clip every component of a weight vector into `[-range, +range]`.
 *
 * @param {number[]} weights
 * @param {number} range
 * @returns {number[]}
 */
export function clipWeights(weights, range = DEFAULTS.clipRange) {
  const r = Math.abs(range);
  return weights.map((v) => {
    if (!Number.isFinite(v)) return 0;
    if (v > r) return r;
    if (v < -r) return -r;
    return v;
  });
}

/**
 * Group-relative advantage: (r_i - mean) / std. Epsilon-guarded std.
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
  const eps = 1e-6;
  const denom = std > eps ? std : 1;
  return rewards.map((r) => (r - mean) / denom);
}

/**
 * L2 divergence between two weight vectors. Length mismatch -> 0.
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

/**
 * Aggregate per-family L2 across the whole weights object. Takes the union of
 * per-family keys so removed/added agents count toward divergence.
 *
 * @param {Record<string, Record<string, number>>} next
 * @param {Record<string, Record<string, number>>} prev
 * @returns {number}
 */
export function klTotal(next, prev) {
  if (!next || typeof next !== 'object') return 0;
  const prevSafe = prev && typeof prev === 'object' ? prev : {};
  let total = 0;
  for (const fam of Object.keys(next)) {
    const keys = unionKeys(next[fam], prevSafe[fam] ?? {});
    const av = keys.map((k) => next[fam]?.[k] ?? 0);
    const bv = keys.map((k) => prevSafe[fam]?.[k] ?? 0);
    total += klFromPrev(av, bv);
  }
  return total;
}

function unionKeys(a, b) {
  const set = new Set();
  if (a && typeof a === 'object') for (const k of Object.keys(a)) {
    if (k !== '__count__') set.add(k);
  }
  if (b && typeof b === 'object') for (const k of Object.keys(b)) {
    if (k !== '__count__') set.add(k);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Candidate resolution + baseline fallback
// ---------------------------------------------------------------------------

/**
 * Extract the baseline agent for a task family from a config-like object.
 * Reads `config.agents.taskBased[taskFamily]`. Returns `null` when no map
 * entry exists. Config is intentionally read-only here (FL1 owns writes).
 *
 * @param {object|null|undefined} config
 * @param {string} taskFamily
 * @returns {string|null}
 */
export function baselineAgentFor(config, taskFamily) {
  const map = config?.agents?.taskBased;
  if (!map || typeof map !== 'object' || !taskFamily) return null;
  return typeof map[taskFamily] === 'string' ? map[taskFamily] : null;
}

/**
 * Default candidate set = learned agents for the family union baseline,
 * falling back to all taskBased agents when the family is fully unknown.
 *
 * @param {Record<string, Record<string, number>>} weights
 * @param {string} taskFamily
 * @param {object} [config]
 * @returns {string[]}
 */
export function defaultCandidates(weights, taskFamily, config) {
  const fromWeights = weights && weights[taskFamily] && typeof weights[taskFamily] === 'object'
    ? Object.keys(weights[taskFamily]).filter((k) => k !== '__count__')
    : [];
  const baseline = baselineAgentFor(config, taskFamily);
  const all = new Set(fromWeights);
  if (baseline) all.add(baseline);
  if (all.size === 0) {
    const map = config?.agents?.taskBased;
    if (map && typeof map === 'object') {
      for (const v of Object.values(map)) {
        if (typeof v === 'string') all.add(v);
      }
    }
  }
  return [...all].sort();
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function argmax(probs) {
  let best = 0;
  let bestV = -Infinity;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] > bestV) {
      bestV = probs[i];
      best = i;
    }
  }
  return best;
}

/**
 * Select an agent from a softmax over learned weights for a family.
 * Deterministic: returns the argmax. Callers may wrap with epsilon-greedy.
 *
 * @param {Record<string, Record<string, number>>} weights
 * @param {string} taskFamily
 * @param {object} [options]
 * @param {string[]} [options.candidates]
 * @param {number} [options.temperature=1.0]
 * @param {object} [options.config]
 * @param {number} [options.minFamilyOccurrences]
 * @returns {{
 *   agent: string|null,
 *   source: 'policy'|'baseline'|'fallback',
 *   distribution: Array<{ agent: string, prob: number, weight: number }>,
 *   confidence: number,
 * }}
 */
export function selectAgent(weights, taskFamily, options = {}) {
  const temperature = options.temperature ?? DEFAULTS.temperature;
  const minOcc = options.minFamilyOccurrences ?? DEFAULTS.minFamilyOccurrences;
  const candidates = Array.isArray(options.candidates) && options.candidates.length > 0
    ? [...options.candidates]
    : defaultCandidates(weights, taskFamily, options.config);

  if (candidates.length === 0) {
    return { agent: null, source: 'fallback', distribution: [], confidence: 0 };
  }

  const familyWeights = weights && weights[taskFamily] && typeof weights[taskFamily] === 'object'
    ? weights[taskFamily]
    : {};
  const seenCount = familyWeights.__count__ ?? 0;

  if (seenCount < minOcc) {
    const baseline = baselineAgentFor(options.config, taskFamily);
    if (baseline && candidates.includes(baseline)) {
      return {
        agent: baseline,
        source: 'baseline',
        distribution: candidates.map((a) => ({
          agent: a,
          prob: a === baseline ? 1 : 0,
          weight: familyWeights[a] ?? 0,
        })),
        confidence: 0,
      };
    }
    if (candidates.length === 1) {
      return {
        agent: candidates[0],
        source: 'baseline',
        distribution: [{ agent: candidates[0], prob: 1, weight: familyWeights[candidates[0]] ?? 0 }],
        confidence: 0,
      };
    }
  }

  const logits = candidates.map((a) => {
    const w = familyWeights[a];
    return typeof w === 'number' && Number.isFinite(w) ? w : 0;
  });
  const probs = softmax(logits, temperature);
  const idx = argmax(probs);
  const distribution = candidates.map((a, i) => ({ agent: a, prob: probs[i], weight: logits[i] }));
  const max = probs[idx] ?? 0;
  const uniform = 1 / Math.max(1, candidates.length);
  const confidence = Math.max(0, Math.min(1, (max - uniform) / (1 - uniform + 1e-9)));
  const source = seenCount >= minOcc ? 'policy' : 'fallback';

  return { agent: candidates[idx] ?? null, source, distribution, confidence };
}

// ---------------------------------------------------------------------------
// Episode normalization + grouping
// ---------------------------------------------------------------------------

/**
 * Normalize an agent-selection episode. Returns `null` on missing fields.
 * Expected shape:
 *   { reward, taskFamily, selectedAgent, candidates?, isExploration? }
 *
 * @param {object} episode
 * @returns {{ family:string, agent:string, reward:number, candidates:string[]|null, exploration:boolean } | null}
 */
export function normalizeEpisode(episode) {
  if (!episode || typeof episode !== 'object') return null;
  if (typeof episode.reward !== 'number' || !Number.isFinite(episode.reward)) return null;
  const family = episode.taskFamily || episode.intentFamily || episode.domain;
  if (typeof family !== 'string' || family.length === 0) return null;
  const agent = episode.selectedAgent || episode.agent;
  if (typeof agent !== 'string' || agent.length === 0) return null;
  return {
    family,
    agent,
    reward: episode.reward,
    candidates: Array.isArray(episode.candidates) && episode.candidates.length > 0
      ? [...episode.candidates]
      : null,
    exploration: Boolean(episode.isExploration),
  };
}

/**
 * Bucket normalized episodes by task family.
 *
 * @param {object[]} episodes
 * @returns {Map<string, ReturnType<typeof normalizeEpisode>[]>}
 */
export function groupByFamily(episodes) {
  const groups = new Map();
  for (const raw of episodes ?? []) {
    const n = normalizeEpisode(raw);
    if (!n) continue;
    const bucket = groups.get(n.family) ?? [];
    bucket.push(n);
    groups.set(n.family, bucket);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Policy update (group-relative softmax policy gradient)
// ---------------------------------------------------------------------------

/**
 * Single-family softmax policy-gradient update with KL shrinkage.
 * For each non-exploration episode, the gradient for agent `a` is
 * `advantage * (1[a=chosen] - pi(a|f))`, summed across episodes.
 */
function updateFamily(prevFamilyWeights, familyEps, opts) {
  const prev = prevFamilyWeights && typeof prevFamilyWeights === 'object' ? prevFamilyWeights : {};
  const trainable = familyEps.filter((e) => !e.exploration);
  const explorationSkipped = familyEps.length - trainable.length;

  const agentSet = new Set();
  for (const k of Object.keys(prev)) {
    if (k === '__count__') continue;
    agentSet.add(k);
  }
  for (const e of trainable) {
    agentSet.add(e.agent);
    if (e.candidates) for (const c of e.candidates) agentSet.add(c);
  }
  const agents = [...agentSet].sort();

  if (trainable.length === 0 || agents.length === 0) {
    return { weights: { ...prev }, episodesUsed: 0, explorationSkipped, agents };
  }

  const prevVec = agents.map((a) => {
    const v = prev[a];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
  let weights = [...prevVec];

  const advantages = computeAdvantages(trainable.map((e) => e.reward));
  const grad = new Array(agents.length).fill(0);
  for (let i = 0; i < trainable.length; i++) {
    const ep = trainable[i];
    const adv = advantages[i];
    const probs = softmax(weights, opts.temperature);
    for (let k = 0; k < agents.length; k++) {
      const indicator = agents[k] === ep.agent ? 1 : 0;
      grad[k] += adv * (indicator - probs[k]);
    }
  }

  for (let k = 0; k < agents.length; k++) {
    weights[k] = weights[k] + opts.learningRate * grad[k] - opts.klPenalty * (weights[k] - prevVec[k]);
  }
  weights = clipWeights(weights, opts.clipRange);

  const next = {};
  for (let k = 0; k < agents.length; k++) next[agents[k]] = weights[k];
  next.__count__ = (prev.__count__ ?? 0) + trainable.length;

  return { weights: next, episodesUsed: trainable.length, explorationSkipped, agents };
}

/**
 * Full-batch update across all families. Exploration-flagged episodes are
 * kept but excluded from the gradient.
 *
 * @param {object[]} episodes
 * @param {Record<string, Record<string, number>>} prevWeights
 * @param {object} [options]
 * @returns {{
 *   weights: Record<string, Record<string, number>>,
 *   episodesUsed: number,
 *   familiesTouched: number,
 *   explorationSkipped: number,
 * }}
 */
export function updatePolicy(episodes, prevWeights, options = {}) {
  const lr = options.learningRate ?? DEFAULTS.learningRate;
  const lambda = options.klPenalty ?? DEFAULTS.klPenalty;
  const temperature = options.temperature ?? DEFAULTS.temperature;
  const clipRange = options.clipRange ?? DEFAULTS.clipRange;
  const iterations = Math.max(1, Math.min(DEFAULTS.maxBatchIterations, options.iterations ?? 1));

  const base = prevWeights && typeof prevWeights === 'object' ? prevWeights : {};
  const result = {};
  for (const fam of Object.keys(base)) {
    result[fam] = { ...(base[fam] ?? {}) };
  }

  const groups = groupByFamily(episodes);
  let totalUsed = 0;
  let explorationSkipped = 0;
  let familiesTouched = 0;

  for (const [family, bucket] of groups) {
    let famWeights = result[family] ?? {};
    let used = 0;
    let skipped = 0;
    for (let it = 0; it < iterations; it++) {
      const upd = updateFamily(famWeights, bucket, {
        learningRate: lr, klPenalty: lambda, temperature, clipRange,
      });
      famWeights = upd.weights;
      if (it === 0) { used = upd.episodesUsed; skipped = upd.explorationSkipped; }
    }
    result[family] = famWeights;
    if (used > 0) familiesTouched += 1;
    totalUsed += used;
    explorationSkipped += skipped;
  }

  return { weights: result, episodesUsed: totalUsed, familiesTouched, explorationSkipped };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the policy on held-out episodes.
 *
 * @param {Record<string, Record<string, number>>} weights
 * @param {object[]} heldOut
 * @param {Record<string, Record<string, number>>} [prevWeights]
 * @param {object} [options]
 * @returns {{ logLoss:number, accuracyVsBaseline:number, klFromPrev:number, samples:number }}
 */
export function evaluatePolicy(weights, heldOut, prevWeights, options = {}) {
  const temperature = options.temperature ?? DEFAULTS.temperature;
  const samples = (heldOut ?? [])
    .map((e) => normalizeEpisode(e))
    .filter((e) => e !== null);

  const klVal = prevWeights ? klTotal(weights, prevWeights) : 0;

  if (samples.length === 0) {
    return { logLoss: 0, accuracyVsBaseline: 0, klFromPrev: klVal, samples: 0 };
  }

  let lossSum = 0;
  let correct = 0;
  const eps = 1e-9;
  for (const s of samples) {
    const familyW = weights?.[s.family] ?? {};
    const agents = s.candidates ?? Object.keys(familyW).filter((k) => k !== '__count__');
    if (agents.length === 0) continue;
    const logits = agents.map((a) => (typeof familyW[a] === 'number' ? familyW[a] : 0));
    const probs = softmax(logits, temperature);
    const idx = agents.indexOf(s.agent);
    if (idx < 0) { lossSum += -Math.log(eps); continue; }
    lossSum += -Math.log(Math.max(eps, probs[idx]));
    if (agents[argmax(probs)] === s.agent) correct++;
  }
  return {
    logLoss: lossSum / samples.length,
    accuracyVsBaseline: correct / samples.length,
    klFromPrev: klVal,
    samples: samples.length,
  };
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/**
 * Top-K agent recommendations for a task family with confidence.
 *
 * @param {Record<string, Record<string, number>>} weights
 * @param {string} taskFamily
 * @param {object} [options]
 * @returns {{
 *   recommendation: string|null,
 *   confidence: number,
 *   source: 'policy'|'baseline'|'fallback',
 *   alternatives: Array<{ agent: string, prob: number, weight: number }>,
 * }}
 */
export function getRecommendation(weights, taskFamily, options = {}) {
  const topK = Math.max(1, options.topK ?? 3);
  const sel = selectAgent(weights, taskFamily, options);
  const sorted = [...sel.distribution].sort((a, b) => b.prob - a.prob).slice(0, topK);
  return {
    recommendation: sel.agent,
    confidence: sel.confidence,
    source: sel.source,
    alternatives: sorted,
  };
}

// ---------------------------------------------------------------------------
// High-level facade
// ---------------------------------------------------------------------------

/**
 * Create a stateful agent-policy instance scoped to a policy file.
 *
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {object} [options.config]         // routing-policy config block
 * @param {object} [options.baseConfig]     // full artibot.config.json for baseline
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]
 * @returns {object}
 */
export function createAgentPolicy(options = {}) {
  const policyPath = options.policyPath;
  const config = { ...DEFAULTS, ...(options.config ?? {}) };
  const baseConfig = options.baseConfig;
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };

  return {
    loadPolicy: () => loadPolicy(policyPath),

    async selectAgent(family, ctx = {}) {
      const prev = await loadPolicy(policyPath);
      const weights = prev?.weights ?? {};
      return selectAgent(weights, family, {
        ...ctx,
        config: ctx.config ?? baseConfig,
        temperature: ctx.temperature ?? config.temperature,
        minFamilyOccurrences: config.minFamilyOccurrences,
      });
    },

    async getRecommendation(family, opts = {}) {
      const prev = await loadPolicy(policyPath);
      const weights = prev?.weights ?? {};
      return getRecommendation(weights, family, {
        ...opts,
        config: opts.config ?? baseConfig,
        temperature: opts.temperature ?? config.temperature,
        minFamilyOccurrences: config.minFamilyOccurrences,
      });
    },

    async trainFromEpisodes(episodes, heldOut) {
      const prev = await loadPolicy(policyPath);
      const prevWeights = prev?.weights ?? {};

      const update = updatePolicy(episodes, prevWeights, {
        learningRate: config.learningRate,
        klPenalty: config.klPenalty,
        temperature: config.temperature,
        clipRange: config.clipRange,
      });

      if (update.episodesUsed === 0) {
        logger.info('no trainable episodes; skipping persistence');
        return { policy: prev, metrics: { reason: 'no-trainable-episodes' } };
      }

      const holdout = heldOut && heldOut.length > 0 ? heldOut : episodes;
      const metrics = evaluatePolicy(update.weights, holdout, prevWeights, {
        temperature: config.temperature,
      });

      if (prev && metrics.klFromPrev > config.klRejectThreshold) {
        logger.warn(`agent policy rejected: KL ${metrics.klFromPrev.toFixed(4)} > ${config.klRejectThreshold}`);
        return { policy: prev, metrics, rejected: 'kl-threshold' };
      }

      const saved = await savePolicy(update.weights, metrics, {
        policyPath,
        trainedOnEpisodes: update.episodesUsed,
        previousSnapshotId: prev?.snapshotId ?? null,
        snapshotCount: config.snapshotCount,
      });
      return { policy: saved.policy, metrics, familiesTouched: update.familiesTouched };
    },

    listSnapshots: () => listSnapshots(policyPath),

    async rollback(n = 1) {
      const snapshots = await listSnapshots(policyPath);
      const idx = Math.max(0, Math.min(snapshots.length - 1, n));
      const target = snapshots[idx];
      if (!target) return null;
      await writeRolledBackPolicy(policyPath, target, snapshots[0]?.id ?? null);
      return { rolledBackTo: target.id, weights: target.weights };
    },
  };
}
