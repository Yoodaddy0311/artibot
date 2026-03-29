/**
 * Feature activation tracker for UX visibility.
 * Collects feature activation events and produces session statistics.
 * Non-intrusive: subscribers opt-in via event-bus; no existing workflow is affected.
 *
 * @module lib/core/feature-tracker
 */

import { on } from './event-bus.js';

// ---------------------------------------------------------------------------
// Feature registry (immutable definitions)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FeatureDef
 * @property {string} id
 * @property {string} symbol
 * @property {string} label
 * @property {string} eventType - event-bus event name
 */

/** @type {readonly FeatureDef[]} */
const FEATURES = Object.freeze([
  { id: 'aci', symbol: '\u26A1', label: 'ACI Constraints', eventType: 'feature:aci-applied' },
  { id: 'context-reset', symbol: '\uD83D\uDD04', label: 'Context Resets', eventType: 'feature:context-reset' },
  { id: 'sprint-contract', symbol: '\uD83D\uDCCB', label: 'Sprint Contracts', eventType: 'feature:sprint-contract' },
  { id: 'eval-separated', symbol: '\uD83D\uDD0D', label: 'Independent Evals', eventType: 'feature:eval-separated' },
  { id: 'source-fetched', symbol: '\uD83D\uDCE1', label: 'Source Fetches', eventType: 'feature:source-fetched' },
  { id: 'cognitive-route', symbol: '\uD83E\uDDE0', label: 'Cognitive Route', eventType: 'feature:cognitive-route' },
  { id: 'token-saving', symbol: '\uD83D\uDCCA', label: 'Token Efficiency', eventType: 'feature:token-saving' },
  { id: 'guardrail', symbol: '\uD83D\uDEE1\uFE0F', label: 'Guardrail', eventType: 'feature:guardrail-applied' },
]);

// ---------------------------------------------------------------------------
// Session store (immutable updates)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FeatureRecord
 * @property {string} featureId
 * @property {number} count
 * @property {string|null} lastDetail
 * @property {number} lastTimestamp
 */

/**
 * Create a fresh tracker store.
 *
 * @returns {Map<string, FeatureRecord>}
 */
function createStore() {
  return new Map();
}

/**
 * Record a feature activation (immutable update).
 *
 * @param {Map<string, FeatureRecord>} store
 * @param {string} featureId
 * @param {string|null} detail
 * @param {number} timestamp
 * @returns {Map<string, FeatureRecord>} new map reference
 */
function recordActivation(store, featureId, detail, timestamp) {
  const prev = store.get(featureId);
  const updated = new Map(store);
  updated.set(featureId, {
    featureId,
    count: (prev?.count ?? 0) + 1,
    lastDetail: detail ?? prev?.lastDetail ?? null,
    lastTimestamp: timestamp,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Indicator formatting
// ---------------------------------------------------------------------------

/**
 * Build an inline indicator string for a feature activation.
 *
 * @param {FeatureDef} def
 * @param {string|null} detail
 * @returns {string}
 */
function formatIndicator(def, detail) {
  const base = `${def.symbol} ${def.label}`;
  return detail ? `${base}: ${detail}` : base;
}

/**
 * Build session dashboard string from store.
 *
 * @param {Map<string, FeatureRecord>} store
 * @returns {string}
 */
function formatDashboard(store) {
  if (store.size === 0) return '';

  const maxLabelLen = FEATURES.reduce(
    (max, f) => Math.max(max, `${f.symbol} ${f.label}`.length),
    0,
  );

  const lines = [];
  for (const def of FEATURES) {
    const record = store.get(def.id);
    if (!record) continue;
    const label = `${def.symbol} ${def.label}`;
    const padded = label.padEnd(maxLabelLen);
    const detail = record.lastDetail
      ? `${record.count}x (${record.lastDetail})`
      : `${record.count}x`;
    lines.push(`| ${padded} : ${detail}`);
  }

  if (lines.length === 0) return '';

  const header = '--- Session Intelligence Report ---';
  return [header, ...lines].join('\n');
}

/**
 * Build compressed indicator (minimal tokens).
 *
 * @param {FeatureDef} def
 * @param {string|null} detail
 * @returns {string}
 */
function formatCompressedIndicator(def, detail) {
  const tag = def.id.toUpperCase().slice(0, 4);
  return detail ? `[${def.symbol}${tag}:${detail}]` : `[${def.symbol}${tag}]`;
}

// ---------------------------------------------------------------------------
// Tracker factory
// ---------------------------------------------------------------------------

/**
 * Create a feature tracker instance.
 * Subscribes to event-bus events for all registered features.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - Clock function
 * @param {boolean} [options.autoSubscribe=true] - Auto-subscribe to event-bus
 * @returns {{
 *   record: (featureId: string, detail?: string|null) => void,
 *   getStore: () => Map<string, FeatureRecord>,
 *   getIndicator: (featureId: string, detail?: string|null) => string,
 *   getCompressedIndicator: (featureId: string, detail?: string|null) => string,
 *   getDashboard: () => string,
 *   getStats: () => { totalActivations: number, activeFeatures: number },
 *   getFeatures: () => readonly FeatureDef[],
 *   destroy: () => void,
 * }}
 */
export function createFeatureTracker(options = {}) {
  const now = options.now ?? Date.now;
  const autoSubscribe = options.autoSubscribe ?? true;

  let store = createStore();
  const subs = [];

  function record(featureId, detail = null) {
    store = recordActivation(store, featureId, detail, now());
  }

  if (autoSubscribe) {
    for (const def of FEATURES) {
      const sub = on(def.eventType, (data) => {
        const detail = typeof data === 'string'
          ? data
          : data?.detail ?? data?.message ?? null;
        record(def.id, detail);
      });
      subs.push(sub);
    }
  }

  function findDef(featureId) {
    return FEATURES.find((f) => f.id === featureId);
  }

  return {
    record,

    getStore() {
      return new Map(store);
    },

    getIndicator(featureId, detail = null) {
      const def = findDef(featureId);
      if (!def) return '';
      return formatIndicator(def, detail);
    },

    getCompressedIndicator(featureId, detail = null) {
      const def = findDef(featureId);
      if (!def) return '';
      return formatCompressedIndicator(def, detail);
    },

    getDashboard() {
      return formatDashboard(store);
    },

    getStats() {
      let totalActivations = 0;
      for (const r of store.values()) {
        totalActivations += r.count;
      }
      return {
        totalActivations,
        activeFeatures: store.size,
      };
    },

    getFeatures() {
      return FEATURES;
    },

    destroy() {
      for (const sub of subs) {
        sub.unsubscribe();
      }
      subs.length = 0;
      store = createStore();
    },
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { FEATURES, formatIndicator, formatCompressedIndicator, formatDashboard };
