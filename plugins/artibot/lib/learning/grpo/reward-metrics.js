/**
 * GRPO-RLVR Reward Metrics (Phase A).
 *
 * Daily roll-up + recent-episode trail for verifiable rewards emitted by
 * {@link module:lib/learning/grpo/reward-capture}. Persists to
 * `runtime/reward-metrics.json` via the shared {@link atomicWriteJson}
 * contract so no reader ever observes a partial file.
 *
 * Schema (on disk):
 * ```
 * {
 *   "updatedAt": "ISO-8601",
 *   "dailyRollups": {
 *     "YYYY-MM-DD": {
 *       count, sum, min, max, mean,
 *       positive, negative, zero, clipped,
 *       componentSums: { toolSuccess, errors, tests, typecheck,
 *                        corrections, promoted, demoted }
 *     }
 *   },
 *   "recentEpisodes": [
 *     { sessionId, ts, reward, components }, ...  (cap 100, newest last)
 *   ]
 * }
 * ```
 *
 * Zero external deps. All public methods are factory-instance-local and the
 * factory returns a frozen object.
 *
 * @module lib/learning/grpo/reward-metrics
 */

import { atomicWriteJson, readJsonFile } from '../../core/file.js';
import { REWARD_CLIP } from './reward-capture.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENT_CAP = 100;

const COMPONENT_KEYS = Object.freeze([
  'toolSuccess',
  'errors',
  'tests',
  'typecheck',
  'corrections',
  'promoted',
  'demoted',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(clock) {
  return new Date(clock()).toISOString().slice(0, 10);
}

function emptyRollup() {
  return {
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    mean: 0,
    positive: 0,
    negative: 0,
    zero: 0,
    clipped: 0,
    componentSums: COMPONENT_KEYS.reduce((acc, k) => {
      acc[k] = 0;
      return acc;
    }, {}),
  };
}

function cloneRollup(source) {
  if (!source || typeof source !== 'object') return emptyRollup();
  const base = emptyRollup();
  return {
    count: Number.isFinite(source.count) ? source.count : 0,
    sum: Number.isFinite(source.sum) ? source.sum : 0,
    min: Number.isFinite(source.min) ? source.min : Number.POSITIVE_INFINITY,
    max: Number.isFinite(source.max) ? source.max : Number.NEGATIVE_INFINITY,
    mean: Number.isFinite(source.mean) ? source.mean : 0,
    positive: Number.isFinite(source.positive) ? source.positive : 0,
    negative: Number.isFinite(source.negative) ? source.negative : 0,
    zero: Number.isFinite(source.zero) ? source.zero : 0,
    clipped: Number.isFinite(source.clipped) ? source.clipped : 0,
    componentSums: COMPONENT_KEYS.reduce((acc, k) => {
      const v = source.componentSums?.[k];
      acc[k] = Number.isFinite(v) ? v : base.componentSums[k];
      return acc;
    }, {}),
  };
}

function emptyState() {
  return { updatedAt: null, dailyRollups: {}, recentEpisodes: [] };
}

function coerceState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  const rollups = (raw.dailyRollups && typeof raw.dailyRollups === 'object')
    ? raw.dailyRollups : {};
  const coerced = {};
  for (const [date, bucket] of Object.entries(rollups)) {
    coerced[date] = cloneRollup(bucket);
  }
  const recent = Array.isArray(raw.recentEpisodes)
    ? raw.recentEpisodes.slice(-RECENT_CAP)
    : [];
  return {
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    dailyRollups: coerced,
    recentEpisodes: recent,
  };
}

function applyReward(rollup, reward, components) {
  rollup.count += 1;
  rollup.sum += reward;
  rollup.min = Math.min(rollup.min, reward);
  rollup.max = Math.max(rollup.max, reward);
  rollup.mean = rollup.sum / rollup.count;
  if (reward > 0) rollup.positive += 1;
  else if (reward < 0) rollup.negative += 1;
  else rollup.zero += 1;
  if (reward === REWARD_CLIP.min || reward === REWARD_CLIP.max) {
    rollup.clipped += 1;
  }
  if (components && typeof components === 'object') {
    for (const k of COMPONENT_KEYS) {
      const v = components[k];
      if (Number.isFinite(v)) rollup.componentSums[k] += v;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a reward-metrics recorder bound to a JSON path + clock.
 *
 * @param {object} options
 * @param {string} options.metricsPath - Absolute path to `reward-metrics.json`
 * @param {() => number} [options.now] - Clock injector for tests
 * @returns {{
 *   recordReward: (sessionId: string, reward: number, components?: object) => Promise<object>,
 *   snapshot: () => Promise<object>,
 *   rollup: (date: string) => Promise<object>
 * }}
 */
export function createRewardMetrics({ metricsPath, now = () => Date.now() } = {}) {
  if (!metricsPath || typeof metricsPath !== 'string') {
    throw new Error('createRewardMetrics: metricsPath required');
  }

  async function load() {
    const raw = await readJsonFile(metricsPath);
    return coerceState(raw);
  }

  async function recordReward(sessionId, reward, components = {}) {
    if (!Number.isFinite(reward)) return null;
    const state = await load();
    const date = isoDate(now);
    const bucket = state.dailyRollups[date] || emptyRollup();
    applyReward(bucket, reward, components);
    state.dailyRollups[date] = bucket;
    const entry = {
      sessionId: sessionId ? String(sessionId) : 'unknown',
      ts: now(),
      reward,
      components: components && typeof components === 'object' ? { ...components } : {},
    };
    state.recentEpisodes = [...state.recentEpisodes, entry].slice(-RECENT_CAP);
    state.updatedAt = new Date(now()).toISOString();
    await atomicWriteJson(metricsPath, state);
    return entry;
  }

  async function snapshot() {
    return load();
  }

  async function rollup(date) {
    const state = await load();
    const bucket = state.dailyRollups[date];
    return bucket ? cloneRollup(bucket) : emptyRollup();
  }

  return Object.freeze({ recordReward, snapshot, rollup });
}
