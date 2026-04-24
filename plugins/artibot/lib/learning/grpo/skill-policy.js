/**
 * GRPO-RLVR Skill Trigger Policy (v3.5 Section 5.5).
 *
 * Maintains per-skill trigger weights trained from verifiable-reward episodes.
 * Each skill carries its own lightweight linear policy over tokenized intent +
 * context features; given a candidate set of skills, the policy emits an invoke
 * score in `[0, 1]` per skill, and `selectSkills` thresholds + top-N caps the
 * set. Unknown (untrained) skills fall back to a neutral 0.5 so the regex /
 * keyword baseline keeps decision authority.
 *
 * Pipeline:
 *   1. Feature extraction — tokenize intent (lowercase words, hyphen/space split),
 *      merge with context keys (commands, intents, domains).
 *   2. Score — per-skill: sum of trigger-weights for matched feature tokens +
 *      baseline_bias, passed through sigmoid.
 *   3. Update — on episode batches, compute group-relative advantage per skill,
 *      shift matched-token weights toward success, decay unused weights.
 *   4. Persist — atomically to `~/.claude/artibot/policies/skill-policy-v1.json`.
 *
 * See `_design/grpo-rlvr-routing-2026-04-24.md` §5.5 and §6 for reward contract.
 *
 * Zero external deps. Deterministic under `NODE_ENV=test`. No network IO.
 *
 * @module lib/learning/grpo/skill-policy
 */

import path from 'node:path';
import { ensureDir, readJsonFile, writeJsonFile } from '../../core/file.js';
import { getHomeDir } from '../../core/platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const POLICY_VERSION = 1;
export const MODEL_TYPE = 'per-skill-weights';

export const DEFAULTS = Object.freeze({
  learningRate: 0.05,
  klPenalty: 0.01,
  weightClip: 3.0,
  decayRate: 0.01,
  minTokenLength: 2,
  maxTokensPerSkill: 64,
  threshold: 0.5,
  maxTriggers: 3,
  snapshotCount: 3,
  neutralScore: 0.5,
});

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/**
 * Tokenize an intent string + optional context into lowercase feature tokens.
 * Filters empties and tokens shorter than `minTokenLength`. Deterministic
 * (preserves insertion order, deduplicates).
 *
 * @param {string|undefined|null} intent
 * @param {{
 *   commands?: string[],
 *   intents?: string[],
 *   domains?: string[],
 *   extraTokens?: string[],
 * }} [context]
 * @param {number} [minLen=DEFAULTS.minTokenLength]
 * @returns {string[]} ordered, deduplicated tokens
 */
export function extractFeatureTokens(intent, context = {}, minLen = DEFAULTS.minTokenLength) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    if (typeof raw !== 'string') return;
    const lower = raw.toLowerCase().trim();
    if (!lower) return;
    for (const tok of lower.split(WORD_SPLIT)) {
      if (!tok || tok.length < minLen) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
    }
  };

  push(intent);
  const bucket = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const v of arr) push(v);
  };
  bucket(context.commands);
  bucket(context.intents);
  bucket(context.domains);
  bucket(context.extraTokens);

  return out;
}

/**
 * Numerically stable sigmoid.
 * @param {number} z
 * @returns {number} in (0, 1)
 */
export function sigmoid(z) {
  if (!Number.isFinite(z)) return 0.5;
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// Per-skill entry shape helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SkillEntry
 * @property {Record<string, number>} triggerWeights
 * @property {number} baseline_bias
 * @property {number} usageCount
 * @property {number} successRate
 */

/**
 * Build an empty entry for a skill. Exposed for tests and migration.
 * @returns {SkillEntry}
 */
export function emptySkillEntry() {
  return {
    triggerWeights: Object.create(null),
    baseline_bias: 0,
    usageCount: 0,
    successRate: 0,
  };
}

/**
 * Ensure a skill entry exists inside `policy.skills` (mutating-safe: returns a
 * fresh object when absent; never mutates an existing entry).
 *
 * @param {{skills: Record<string, SkillEntry>}} policy
 * @param {string} name
 * @returns {SkillEntry}
 */
function ensureEntry(policy, name) {
  if (!policy.skills[name]) policy.skills[name] = emptySkillEntry();
  return policy.skills[name];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute the linear pre-sigmoid logit for a skill entry against a set of
 * feature tokens. Unknown tokens contribute zero. Missing entries yield 0.
 *
 * @param {SkillEntry|undefined} entry
 * @param {string[]} tokens
 * @returns {number}
 */
export function computeLogit(entry, tokens) {
  if (!entry || typeof entry !== 'object') return 0;
  const w = entry.triggerWeights ?? {};
  let z = Number.isFinite(entry.baseline_bias) ? entry.baseline_bias : 0;
  for (const t of tokens) {
    const v = w[t];
    if (typeof v === 'number' && Number.isFinite(v)) z += v;
  }
  return z;
}

/**
 * Score each candidate skill. Returns a map of skill name -> invoke score
 * in `[0, 1]`. Skills without a trained entry default to `neutralScore`
 * (0.5 by default) so the regex baseline keeps authority.
 *
 * @param {object} policy - loaded policy object ({ skills, ... })
 * @param {string} intent
 * @param {object} [context]
 * @param {string[]} candidates
 * @param {{ neutralScore?: number, minTokenLength?: number }} [options]
 * @returns {Record<string, number>}
 */
export function scoreSkillsWith(policy, intent, context, candidates, options = {}) {
  const neutral = options.neutralScore ?? DEFAULTS.neutralScore;
  const minLen = options.minTokenLength ?? DEFAULTS.minTokenLength;
  const out = Object.create(null);
  if (!Array.isArray(candidates) || candidates.length === 0) return out;

  const tokens = extractFeatureTokens(intent, context, minLen);
  const skills = policy?.skills ?? {};

  for (const name of candidates) {
    if (typeof name !== 'string' || !name) continue;
    const entry = skills[name];
    if (!entry) {
      out[name] = neutral;
      continue;
    }
    out[name] = sigmoid(computeLogit(entry, tokens));
  }
  return out;
}

/**
 * Threshold + top-N selection over a score map.
 *
 * @param {Record<string, number>} scores
 * @param {{ threshold?: number, maxTriggers?: number }} [options]
 * @returns {{ name: string, score: number }[]} sorted desc by score
 */
export function selectFromScores(scores, options = {}) {
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const maxTriggers = options.maxTriggers ?? DEFAULTS.maxTriggers;
  const entries = [];
  for (const [name, score] of Object.entries(scores ?? {})) {
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    if (score < threshold) continue;
    entries.push({ name, score });
  }
  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, Math.max(0, maxTriggers));
}

// ---------------------------------------------------------------------------
// Update math
// ---------------------------------------------------------------------------

/**
 * Group-relative advantage: (r - mean) / std. Matches policy-updater.js
 * semantics; duplicated here to keep skill-policy self-contained.
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
  let sq = 0;
  for (const r of rewards) {
    const d = r - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / n);
  const denom = std > 1e-6 ? std : 1;
  return rewards.map((r) => (r - mean) / denom);
}

/**
 * Apply a single update step to a skill entry given a matched token set,
 * advantage, and learning rate. Mutates `entry` in place (caller owns copy).
 *
 * @param {SkillEntry} entry
 * @param {string[]} tokens
 * @param {number} advantage
 * @param {object} [options]
 * @param {number} [options.learningRate=DEFAULTS.learningRate]
 * @param {number} [options.weightClip=DEFAULTS.weightClip]
 * @param {number} [options.maxTokens=DEFAULTS.maxTokensPerSkill]
 * @returns {void}
 */
export function applyUpdate(entry, tokens, advantage, options = {}) {
  const lr = options.learningRate ?? DEFAULTS.learningRate;
  const clip = options.weightClip ?? DEFAULTS.weightClip;
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokensPerSkill;

  const w = entry.triggerWeights;
  for (const t of tokens) {
    const prev = typeof w[t] === 'number' && Number.isFinite(w[t]) ? w[t] : 0;
    const next = clamp(prev + lr * advantage, -clip, clip);
    w[t] = next;
  }

  // Baseline bias also nudges with a fraction of the signal — acts as a
  // global prior for the skill so untokenized but recurring invocations
  // still gain signal.
  const bias = Number.isFinite(entry.baseline_bias) ? entry.baseline_bias : 0;
  entry.baseline_bias = clamp(bias + 0.25 * lr * advantage, -clip, clip);

  // Cap dictionary size — drop the lowest-|w| entries when over budget.
  const keys = Object.keys(w);
  if (keys.length > maxTokens) {
    const ranked = keys.map((k) => ({ k, mag: Math.abs(w[k]) })).sort((a, b) => a.mag - b.mag);
    const toDrop = ranked.slice(0, keys.length - maxTokens);
    for (const { k } of toDrop) delete w[k];
  }
}

/**
 * Weight decay — shrink every weight slightly each training night to keep
 * stale signals from pinning scores. Skips entries that are already zero.
 *
 * @param {SkillEntry} entry
 * @param {number} [rate=DEFAULTS.decayRate]
 * @returns {void}
 */
export function decayEntry(entry, rate = DEFAULTS.decayRate) {
  if (!entry || !entry.triggerWeights) return;
  const r = clamp(rate, 0, 1);
  if (r === 0) return;
  const keep = 1 - r;
  const w = entry.triggerWeights;
  for (const k of Object.keys(w)) {
    const v = w[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    w[k] = v * keep;
  }
  if (typeof entry.baseline_bias === 'number' && Number.isFinite(entry.baseline_bias)) {
    entry.baseline_bias *= keep;
  }
}

/**
 * Normalize an episode record into the training shape expected by
 * {@link trainBatch}. Each episode may have zero, one, or many skills
 * that were invoked — we replicate the reward across all of them so
 * each skill's gradient sees its own outcome.
 *
 * Expected episode shape:
 *   {
 *     reward: number,            // verifiable in [-1.5, +1.2]
 *     intent: string,
 *     context?: object,
 *     skillsUsed: string[],      // skills that fired for this episode
 *     isExploration?: boolean,
 *   }
 *
 * @param {object} episode
 * @returns {{
 *   reward: number,
 *   tokens: string[],
 *   skillsUsed: string[],
 *   exploration: boolean,
 * } | null}
 */
export function normalizeEpisode(episode) {
  if (!episode || typeof episode !== 'object') return null;
  if (typeof episode.reward !== 'number' || !Number.isFinite(episode.reward)) return null;
  const skillsUsed = Array.isArray(episode.skillsUsed) ? episode.skillsUsed.filter((s) => typeof s === 'string' && s) : [];
  if (skillsUsed.length === 0) return null;
  const tokens = extractFeatureTokens(
    typeof episode.intent === 'string' ? episode.intent : '',
    episode.context ?? {},
  );
  return {
    reward: episode.reward,
    tokens,
    skillsUsed,
    exploration: Boolean(episode.isExploration),
  };
}

/**
 * Train every candidate skill on a batch of episodes.
 *
 * For each skill, pull the episodes that actually invoked it, derive a
 * group-relative advantage, and shift that skill's trigger weights toward
 * the matched tokens scaled by the advantage. Exploration-flagged episodes
 * are dropped from the gradient path (but counted for usage stats).
 *
 * @param {object} policy - `{ skills: Record<string, SkillEntry> }` — mutated
 * @param {object[]} episodes
 * @param {object} [options]
 * @returns {{ skillsTouched: number, episodesUsed: number, explorationSkipped: number }}
 */
export function trainBatch(policy, episodes, options = {}) {
  const normalized = [];
  let explorationSkipped = 0;
  for (const ep of episodes ?? []) {
    const n = normalizeEpisode(ep);
    if (!n) continue;
    if (n.exploration) {
      explorationSkipped++;
      continue;
    }
    normalized.push(n);
  }

  if (normalized.length === 0) {
    return { skillsTouched: 0, episodesUsed: 0, explorationSkipped };
  }

  // Bucket by skill
  const bySkill = new Map();
  for (const n of normalized) {
    for (const s of n.skillsUsed) {
      const bucket = bySkill.get(s) ?? [];
      bucket.push(n);
      bySkill.set(s, bucket);
    }
  }

  let skillsTouched = 0;
  for (const [skill, bucket] of bySkill) {
    const entry = ensureEntry(policy, skill);
    const rewards = bucket.map((b) => b.reward);
    const advantages = computeAdvantages(rewards);
    for (let i = 0; i < bucket.length; i++) {
      applyUpdate(entry, bucket[i].tokens, advantages[i], options);
      entry.usageCount = (entry.usageCount ?? 0) + 1;
    }
    const successes = rewards.filter((r) => r > 0).length;
    const total = rewards.length;
    entry.successRate = total > 0 ? successes / total : 0;
    skillsTouched++;
  }

  // Decay untouched skills so their weights drift toward the prior.
  const decay = options.decayRate ?? DEFAULTS.decayRate;
  for (const name of Object.keys(policy.skills)) {
    if (!bySkill.has(name)) decayEntry(policy.skills[name], decay);
  }

  return { skillsTouched, episodesUsed: normalized.length, explorationSkipped };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Resolve the skill-policy storage paths. Honors absolute `policyPath`
 * overrides; otherwise uses `~/.claude/artibot/policies/skill-policy-v1.json`.
 *
 * @param {string} [policyPath]
 * @returns {{ policyFile: string, snapshotDir: string }}
 */
export function resolvePolicyPaths(policyPath) {
  const file = policyPath && path.isAbsolute(policyPath)
    ? policyPath
    : path.join(getHomeDir(), '.claude', 'artibot', 'policies', 'skill-policy-v1.json');
  const dir = path.dirname(file);
  return { policyFile: file, snapshotDir: path.join(dir, 'skill-snapshots') };
}

function makeSnapshotId(now = new Date()) {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `sk${POLICY_VERSION}-${iso}-${rand}`;
}

/**
 * Build a fresh empty policy record. Useful when the file does not yet exist.
 * @returns {{ version: number, modelType: string, skills: Record<string, SkillEntry>, trainedAt: null, metrics: object }}
 */
export function emptyPolicy() {
  return {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    skills: Object.create(null),
    trainedAt: null,
    metrics: {},
  };
}

/**
 * Load the current skill policy from disk. Returns `null` when missing or
 * malformed.
 *
 * @param {string} [policyPath]
 * @returns {Promise<object|null>}
 */
export async function loadPolicy(policyPath) {
  const { policyFile } = resolvePolicyPaths(policyPath);
  const data = await readJsonFile(policyFile);
  if (!data || typeof data !== 'object') return null;
  if (data.modelType !== MODEL_TYPE) return null;
  if (!data.skills || typeof data.skills !== 'object') return null;
  return data;
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

/**
 * Atomic-ish write of the skill policy record plus rotating snapshot.
 *
 * @param {object} policy
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {object} [options.metrics]
 * @param {number} [options.snapshotCount=DEFAULTS.snapshotCount]
 * @returns {Promise<{ policy: object, snapshotId: string, policyFile: string }>}
 */
export async function savePolicy(policy, options = {}) {
  const { policyFile, snapshotDir } = resolvePolicyPaths(options.policyPath);
  const snapshotCount = options.snapshotCount ?? DEFAULTS.snapshotCount;

  await ensureDir(path.dirname(policyFile));
  await ensureDir(snapshotDir);

  const snapshotId = makeSnapshotId();
  const metrics = options.metrics ?? policy.metrics ?? {};
  const record = {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    skills: serializeSkills(policy.skills ?? {}),
    trainedAt: new Date().toISOString(),
    metrics: {
      skillsTouched: metrics.skillsTouched ?? 0,
      episodesUsed: metrics.episodesUsed ?? 0,
      explorationSkipped: metrics.explorationSkipped ?? 0,
      meanSuccessRate: round6(metrics.meanSuccessRate ?? computeMeanSuccessRate(policy.skills ?? {})),
    },
    snapshotId,
  };

  await writeJsonFile(policyFile, record);
  await writeJsonFile(path.join(snapshotDir, `${snapshotId}.json`), record);
  await pruneSnapshots(snapshotDir, snapshotCount);
  return { policy: record, snapshotId, policyFile };
}

function serializeSkills(skills) {
  const out = {};
  for (const [name, entry] of Object.entries(skills)) {
    if (!entry || typeof entry !== 'object') continue;
    out[name] = {
      triggerWeights: { ...entry.triggerWeights },
      baseline_bias: Number.isFinite(entry.baseline_bias) ? entry.baseline_bias : 0,
      usageCount: Number.isFinite(entry.usageCount) ? entry.usageCount : 0,
      successRate: Number.isFinite(entry.successRate) ? entry.successRate : 0,
    };
  }
  return out;
}

function computeMeanSuccessRate(skills) {
  const values = Object.values(skills)
    .map((e) => (e && Number.isFinite(e.successRate) ? e.successRate : null))
    .filter((v) => v !== null);
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * Create a stateful skill-policy facade scoped to a policy file. Mirrors the
 * `createPolicyUpdater` shape from the routing policy for consistency across
 * GRPO-trained surfaces.
 *
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {object} [options.config]
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]
 * @returns {{
 *   loadPolicy: () => Promise<object|null>,
 *   scoreSkills: (intent: string, context: object, opts: { candidates: string[] }) =>
 *     Promise<Record<string, number>>,
 *   selectSkills: (intent: string, context: object, opts: {
 *     candidates: string[], threshold?: number, maxTriggers?: number,
 *   }) => Promise<{ name: string, score: number }[]>,
 *   updatePolicy: (episodes: object[]) => Promise<{
 *     policy: object|null, metrics: object,
 *   }>,
 * }}
 */
export function createSkillPolicy(options = {}) {
  const policyPath = options.policyPath;
  const config = { ...DEFAULTS, ...(options.config ?? {}) };
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };

  return {
    loadPolicy: () => loadPolicy(policyPath),

    async scoreSkills(intent, context, opts = {}) {
      const candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
      const policy = (await loadPolicy(policyPath)) ?? emptyPolicy();
      return scoreSkillsWith(policy, intent, context, candidates, {
        neutralScore: config.neutralScore,
      });
    },

    async selectSkills(intent, context, opts = {}) {
      const candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
      const threshold = opts.threshold ?? config.threshold;
      const maxTriggers = opts.maxTriggers ?? config.maxTriggers;
      const policy = (await loadPolicy(policyPath)) ?? emptyPolicy();
      const scores = scoreSkillsWith(policy, intent, context, candidates, {
        neutralScore: config.neutralScore,
      });
      return selectFromScores(scores, { threshold, maxTriggers });
    },

    async updatePolicy(episodes) {
      const prev = (await loadPolicy(policyPath)) ?? emptyPolicy();
      // Clone to avoid mutating the cached read
      const working = {
        ...prev,
        skills: deepCloneSkills(prev.skills ?? {}),
      };
      const metrics = trainBatch(working, episodes, {
        learningRate: config.learningRate,
        weightClip: config.weightClip,
        maxTokens: config.maxTokensPerSkill,
        decayRate: config.decayRate,
      });

      if (metrics.episodesUsed === 0 && metrics.skillsTouched === 0) {
        logger.info('skill-policy: no eligible episodes, skipping save');
        return { policy: prev, metrics: { ...metrics, reason: 'no-episodes' } };
      }

      const mean = computeMeanSuccessRate(working.skills);
      const saved = await savePolicy(working, {
        policyPath,
        metrics: { ...metrics, meanSuccessRate: mean },
        snapshotCount: config.snapshotCount,
      });
      return { policy: saved.policy, metrics: { ...metrics, meanSuccessRate: mean } };
    },
  };
}

function deepCloneSkills(skills) {
  const out = Object.create(null);
  for (const [name, entry] of Object.entries(skills ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    out[name] = {
      triggerWeights: { ...(entry.triggerWeights ?? {}) },
      baseline_bias: Number.isFinite(entry.baseline_bias) ? entry.baseline_bias : 0,
      usageCount: Number.isFinite(entry.usageCount) ? entry.usageCount : 0,
      successRate: Number.isFinite(entry.successRate) ? entry.successRate : 0,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Thin public wrappers (match spec naming)
// ---------------------------------------------------------------------------

/**
 * Standalone score helper. Loads the policy each call — prefer the facade for
 * batch scoring since it uses the cached read.
 *
 * @param {string} intent
 * @param {object} context
 * @param {{ candidates: string[], policyPath?: string }} opts
 * @returns {Promise<Record<string, number>>}
 */
export async function scoreSkills(intent, context, opts) {
  const policy = (await loadPolicy(opts?.policyPath)) ?? emptyPolicy();
  return scoreSkillsWith(policy, intent, context, opts?.candidates ?? []);
}

/**
 * Standalone select helper (threshold + top-N).
 *
 * @param {string} intent
 * @param {object} context
 * @param {{
 *   candidates: string[],
 *   threshold?: number,
 *   maxTriggers?: number,
 *   policyPath?: string,
 * }} opts
 * @returns {Promise<{ name: string, score: number }[]>}
 */
export async function selectSkills(intent, context, opts) {
  const scores = await scoreSkills(intent, context, opts);
  return selectFromScores(scores, {
    threshold: opts?.threshold ?? DEFAULTS.threshold,
    maxTriggers: opts?.maxTriggers ?? DEFAULTS.maxTriggers,
  });
}

/**
 * Standalone batch updater. Persists via savePolicy when any skill was
 * touched, otherwise returns the previous policy untouched.
 *
 * @param {object[]} episodes
 * @param {{ policyPath?: string, config?: object }} [opts]
 * @returns {Promise<{ policy: object|null, metrics: object }>}
 */
export async function updatePolicy(episodes, opts = {}) {
  return createSkillPolicy({ policyPath: opts.policyPath, config: opts.config }).updatePolicy(episodes);
}
