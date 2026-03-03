/**
 * Differential Privacy Module.
 *
 * Implements Laplacian noise injection for federated learning weight sharing.
 * Uses node:crypto CSPRNG (NOT Math.random) for cryptographic randomness.
 *
 * Privacy guarantee: (ε, δ)-differential privacy where:
 *   - ε (epsilon) controls privacy/utility trade-off (lower = more private)
 *   - δ (delta) bounds probability of privacy breach
 *
 * @module lib/privacy/differential-privacy
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default privacy parameters */
const DEFAULT_EPSILON = 1.0;

/** Fields excluded from noise injection (metadata, not learnable weights) */
const EXCLUDED_FIELDS = new Set(['sampleSize', 'storedAt', 'version', 'checksum']);

// ---------------------------------------------------------------------------
// CSPRNG Uniform Random
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure uniform random number in [0, 1).
 * Uses node:crypto randomBytes for true randomness.
 *
 * @returns {number}
 */
function secureRandom() {
  const buf = randomBytes(4);
  return buf.readUInt32BE(0) / 0x100000000;
}

// ---------------------------------------------------------------------------
// Laplacian Noise
// ---------------------------------------------------------------------------

/**
 * Sample from a Laplace distribution centered at 0 with scale parameter b.
 *
 * Uses the inverse CDF method: L = -b * sign(u - 0.5) * ln(1 - 2|u - 0.5|)
 * where u is uniform in (0, 1).
 *
 * @param {number} scale - Scale parameter (b = sensitivity / epsilon)
 * @returns {number} Random sample from Laplace(0, scale)
 */
function laplaceSample(scale) {
  let u = secureRandom();
  // Avoid exact 0 or 0.5 which cause ln(0) = -Infinity
  while (u === 0 || u === 0.5) {
    u = secureRandom();
  }

  const sign = u < 0.5 ? -1 : 1;
  return -scale * sign * Math.log(1 - 2 * Math.abs(u - 0.5));
}

/**
 * Compute the Laplace scale parameter for a given epsilon and sensitivity.
 *
 * For numeric weights normalized to [0, 1], sensitivity = 1.
 *
 * @param {number} epsilon - Privacy budget
 * @param {number} [sensitivity=1] - Query sensitivity (max change from one record)
 * @returns {number} Scale parameter b
 */
function computeScale(epsilon, sensitivity = 1) {
  if (epsilon <= 0) throw new Error('Epsilon must be positive');
  return sensitivity / epsilon;
}

// ---------------------------------------------------------------------------
// Noise Application
// ---------------------------------------------------------------------------

/**
 * Apply Laplacian noise to a single numeric value and clamp to [0, 1].
 *
 * @param {number} value - Original value (expected in [0, 1])
 * @param {number} scale - Laplace scale parameter
 * @returns {number} Noised and clamped value
 */
function addNoiseToValue(value, scale) {
  const noised = value + laplaceSample(scale);
  return Math.max(0, Math.min(1, noised));
}

/**
 * Recursively apply noise to all numeric fields in an object.
 * Skips excluded fields (sampleSize, metadata).
 *
 * @param {*} data - Input data (object, array, number, or other)
 * @param {number} scale - Laplace scale parameter
 * @param {string} [fieldName] - Current field name for exclusion check
 * @returns {*} Data with noise applied to numeric fields
 */
function applyNoiseRecursive(data, scale, fieldName) {
  if (data === null || data === undefined) return data;

  // Skip excluded fields
  if (fieldName && EXCLUDED_FIELDS.has(fieldName)) return data;

  if (typeof data === 'number') {
    return addNoiseToValue(data, scale);
  }

  if (Array.isArray(data)) {
    return data.map((item, i) => applyNoiseRecursive(item, scale, String(i)));
  }

  if (typeof data === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = applyNoiseRecursive(value, scale, key);
    }
    return result;
  }

  // Non-numeric, non-object: return as-is (strings, booleans)
  return data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a noise function compatible with swarm-client's `addNoise` interface.
 *
 * Returns a function that takes a weights object and returns a new object
 * with Laplacian noise applied to all numeric fields (except excluded ones).
 *
 * @param {object} [config] - Differential privacy configuration
 * @param {number} [config.epsilon=1.0] - Privacy budget (lower = more private, noisier)
 * @param {number} [config.delta=1e-5] - Privacy breach probability bound
 * @param {boolean} [config.enabled=true] - Whether to apply noise
 * @returns {(weights: object) => object} Noise function for swarm-client
 *
 * @example
 * const addNoise = createNoiseFunction({ epsilon: 1.0 });
 * const noisedWeights = addNoise(originalWeights);
 */
export function createNoiseFunction(config = {}) {
  const {
    epsilon = DEFAULT_EPSILON,
    // delta is accepted for config compatibility but not used in Laplace mechanism
    enabled = true,
  } = config;

  if (!enabled) {
    return (weights) => weights;
  }

  const scale = computeScale(epsilon);

  return (weights) => {
    if (!weights || typeof weights !== 'object') return weights;
    return applyNoiseRecursive(weights, scale);
  };
}

/**
 * Validate differential privacy configuration.
 *
 * @param {object} config - DP config to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDPConfig(config) {
  const errors = [];

  if (config.epsilon !== undefined) {
    if (typeof config.epsilon !== 'number' || config.epsilon <= 0) {
      errors.push('epsilon must be a positive number');
    }
  }

  if (config.delta !== undefined) {
    if (typeof config.delta !== 'number' || config.delta < 0 || config.delta >= 1) {
      errors.push('delta must be a number in [0, 1)');
    }
  }

  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  laplaceSample,
  computeScale,
  addNoiseToValue,
  secureRandom,
  EXCLUDED_FIELDS,
};
