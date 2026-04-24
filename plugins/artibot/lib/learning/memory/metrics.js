/**
 * Per-layer hit-rate metrics for the hierarchical memory system.
 *
 * Accumulates {queries, hits, rate} per layer (working/episodic/semantic)
 * and rolls up daily to runtime/memory-metrics.json via atomic write.
 *
 * Zero external deps. In-memory accumulator + atomic disk persistence.
 *
 * @module lib/learning/memory/metrics
 */

import path from 'node:path';
import { atomicWriteJson, readJsonFile } from '../../core/file.js';

const LAYERS = Object.freeze(['working', 'episodic', 'semantic']);

function emptyBucket() {
  return { hits: 0, queries: 0, rate: 0 };
}

function emptySnapshot(dateStr) {
  return {
    date: dateStr,
    working: emptyBucket(),
    episodic: emptyBucket(),
    semantic: emptyBucket(),
  };
}

function todayIso(clock) {
  const d = new Date(clock());
  return d.toISOString().slice(0, 10);
}

function recalcRate(bucket) {
  return bucket.queries === 0 ? 0 : bucket.hits / bucket.queries;
}

/**
 * Factory for a memory-metrics recorder bound to a runtime path + clock.
 * Returned API is immutable (frozen); state is module-internal to the
 * factory closure so callers get isolated counters per instance.
 *
 * @param {object} options
 * @param {string} options.metricsPath - Absolute path to memory-metrics.json
 * @param {() => number} [options.now] - Clock injector for tests
 * @returns {object} { recordQuery, recordHit, snapshot, rollup, resetDaily, load }
 */
export function createMetricsRecorder({ metricsPath, now = () => Date.now() } = {}) {
  if (!metricsPath || typeof metricsPath !== 'string') {
    throw new Error('createMetricsRecorder: metricsPath required');
  }

  let state = emptySnapshot(todayIso(now));

  /**
   * Record a query against a layer. Optionally bundle hits from the same
   * query for atomicity.
   * @param {'working'|'episodic'|'semantic'} layer
   * @param {number} [hits=0]
   */
  function recordQuery(layer, hits = 0) {
    if (!LAYERS.includes(layer)) return;
    const bucket = state[layer];
    const next = {
      hits: bucket.hits + Math.max(0, hits | 0),
      queries: bucket.queries + 1,
    };
    state = {
      ...state,
      [layer]: { ...next, rate: recalcRate(next) },
    };
  }

  /**
   * Register a single hit — used when hits stream in separately from the
   * initial recordQuery call.
   * @param {'working'|'episodic'|'semantic'} layer
   */
  function recordHit(layer) {
    if (!LAYERS.includes(layer)) return;
    const bucket = state[layer];
    const next = { hits: bucket.hits + 1, queries: bucket.queries };
    state = {
      ...state,
      [layer]: { ...next, rate: recalcRate(next) },
    };
  }

  /**
   * Return a frozen snapshot of the current in-RAM counters.
   * @returns {Readonly<object>}
   */
  function snapshot() {
    return Object.freeze({
      date: state.date,
      working: Object.freeze({ ...state.working }),
      episodic: Object.freeze({ ...state.episodic }),
      semantic: Object.freeze({ ...state.semantic }),
    });
  }

  /**
   * Persist a daily rollup. If `date` differs from the current snapshot,
   * the snapshot is stored under its own date and counters are reset.
   * @param {string} [date] - YYYY-MM-DD override (defaults to snapshot.date)
   * @returns {Promise<object>} the snapshot that was written
   */
  async function rollup(date) {
    const target = date || state.date;
    const written = {
      ...state,
      date: target,
    };
    await atomicWriteJson(metricsPath, written);
    if (target !== state.date) {
      state = emptySnapshot(state.date);
    }
    return written;
  }

  /**
   * Reset in-RAM counters to a fresh day. If the clock advanced past the
   * current snapshot's date, the old snapshot is flushed first.
   */
  async function resetDaily() {
    const iso = todayIso(now);
    if (iso !== state.date) {
      await rollup(state.date).catch(() => { /* best-effort */ });
    }
    state = emptySnapshot(iso);
  }

  /**
   * Best-effort restore from disk. Returns the previously-persisted snapshot
   * (for the same date) into RAM — useful on process start.
   * @returns {Promise<void>}
   */
  async function load() {
    const raw = await readJsonFile(metricsPath);
    if (!raw || raw.date !== state.date) return;
    const safe = (bucket) => (
      bucket && typeof bucket === 'object'
        ? { hits: bucket.hits | 0, queries: bucket.queries | 0, rate: bucket.rate ?? 0 }
        : emptyBucket()
    );
    state = {
      date: raw.date,
      working: safe(raw.working),
      episodic: safe(raw.episodic),
      semantic: safe(raw.semantic),
    };
    // Recompute rates in case of drift.
    for (const l of LAYERS) state[l].rate = recalcRate(state[l]);
  }

  return Object.freeze({
    recordQuery,
    recordHit,
    snapshot,
    rollup,
    resetDaily,
    load,
    metricsPath,
  });
}

/**
 * Convenience helper that resolves a default metrics path under a plugin
 * root. Keeps the path logic centralised so façade callers don't have to
 * duplicate `path.join(root, 'runtime', 'memory-metrics.json')`.
 * @param {string} pluginRoot
 * @returns {string}
 */
export function defaultMetricsPath(pluginRoot) {
  return path.join(pluginRoot, 'runtime', 'memory-metrics.json');
}
