/**
 * Ledger → learning swarm bridge (F-06 D3 — R2 privacy enforcement).
 *
 * The single sanctioned path for ledger-DERIVED learning signal to reach the
 * swarm. F-06 R2 mandates that ledger-origin data is ALWAYS sent through the
 * differential-privacy layer (ε=1.0) — even when the global swarm config leaves
 * DP optional. This module guarantees that, and stamps `metadata.source =
 * 'ledger'` so the swarm-client egress guard (AC1) can refuse any raw bypass.
 *
 * Layering: Learning (3) → Swarm/Privacy (2). Upper imports lower only.
 *
 * @module lib/learning/ledger/learning-bridge
 */

import { createNoiseFunction } from '../../privacy/differential-privacy.js';
import { resolvePrivacyChain } from '../../swarm/sync-scheduler.js';
import { uploadWeights as defaultUploadWeights } from '../../swarm/swarm-client.js';

// F-06 R2: ledger data is noised at the standard swarm budget regardless of
// config (the config toggle governs ordinary git-commit learning, not ledger).
const LEDGER_EPSILON = 1.0;

/**
 * Build the privacy chain for ledger-derived data with differential privacy
 * GUARANTEED. Reuses the canonical {@link resolvePrivacyChain}; when it yields
 * no noise fn (DP disabled / absent / no override), a forced ε=1.0 noise fn is
 * substituted so ledger data is never sent un-noised.
 *
 * @param {{ config?: object, scrubPii?: Function, addNoise?: Function }} [options]
 * @returns {{ scrubPii: Function, addNoise: Function }}
 */
export function buildLedgerPrivacyChain(options = {}) {
  const { scrubPii, addNoise } = resolvePrivacyChain(options);
  const guaranteedNoise = typeof addNoise === 'function'
    ? addNoise
    : createNoiseFunction({ epsilon: LEDGER_EPSILON });
  return { scrubPii, addNoise: guaranteedNoise };
}

/**
 * Upload ledger-derived weights with the privacy contract enforced. Stamps
 * `source: 'ledger'` and supplies a guaranteed scrub + noise chain, then
 * delegates to swarm-client `uploadWeights`. Best-effort: returns the
 * uploader's result verbatim.
 *
 * @param {object} weights - Pattern/weight payload derived from ledger corpus.
 * @param {object} [metadata] - Upload metadata (merged; `source` is forced).
 * @param {object} [options] - { config, scrubPii?, addNoise? }.
 * @param {{ uploadWeights?: Function }} [deps] - Test seam.
 * @returns {Promise<object>} uploadWeights result.
 */
export async function uploadLedgerCorpus(weights, metadata = {}, options = {}, deps = {}) {
  const upload = typeof deps.uploadWeights === 'function' ? deps.uploadWeights : defaultUploadWeights;
  const { scrubPii, addNoise } = buildLedgerPrivacyChain(options);
  return upload(
    weights,
    { ...metadata, source: 'ledger' },
    { ...options, scrubPii, addNoise },
  );
}

export const _internals = Object.freeze({ LEDGER_EPSILON });
