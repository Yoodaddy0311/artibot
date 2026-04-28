/**
 * GRPO Policy Factory (v3.6).
 *
 * Creates a policy instance of the requested `modelType`, wrapping the
 * underlying implementation behind a uniform interface so callers (trainers,
 * evaluators, the cognitive router) can swap between a linear logistic
 * regression head (v3.4) and a small MLP head (v3.6) without rewriting
 * pipeline code.
 *
 * Common interface:
 *   {
 *     type: 'linear' | 'mlp',
 *     predict(theta|model, x) -> number,
 *     trainBatch(episodes, prev, options) -> { theta|model, ...stats },
 *     evaluatePolicy(theta|model, heldOut, prev) -> { logLoss, accuracy... },
 *     savePolicy(theta|model, metrics, options) -> Promise<{ policy, ... }>,
 *     snapshot(theta|model, id, policyPath) -> Promise<string>,
 *   }
 *
 * Dispatch precedence:
 *   1. Explicit `type` argument to `createPolicy({ type })`.
 *   2. `modelType` field inside a loaded policy file.
 *   3. `config.learning.grpoRouting.modelType`.
 *   4. Fallback to 'linear' with a logger.warn() for unknown values.
 *
 * Zero external deps. No network IO. Safe for test environments.
 *
 * @module lib/learning/grpo/policy-factory
 */

import * as linearImpl from './policy-updater.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SUPPORTED_TYPES = Object.freeze(['linear', 'mlp']);
export const DEFAULT_TYPE = 'linear';

const NULL_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

// ---------------------------------------------------------------------------
// Type resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a policy type string. Unknown / missing inputs fall back to
 * `DEFAULT_TYPE` and log a warning via `logger.warn`. Matching is
 * case-insensitive and whitespace-tolerant.
 *
 * @param {unknown} input
 * @param {{ warn?: Function }} [logger]
 * @returns {'linear'|'mlp'}
 */
export function resolvePolicyType(input, logger = NULL_LOGGER) {
  if (typeof input !== 'string' || input.trim() === '') {
    return DEFAULT_TYPE;
  }
  const key = input.trim().toLowerCase();
  if (SUPPORTED_TYPES.includes(key)) {
    return /** @type {'linear'|'mlp'} */ (key);
  }
  if (typeof logger.warn === 'function') {
    logger.warn(
      `policy-factory: unknown modelType "${input}", falling back to "${DEFAULT_TYPE}"`,
    );
  }
  return DEFAULT_TYPE;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * Wrap the v3.4 linear policy-updater module into the factory interface.
 *
 * @param {object} [config]
 * @returns {object}
 */
function createLinearAdapter(config = {}) {
  return Object.freeze({
    type: 'linear',
    modelType: 'logistic-regression',
    config,
    predict: (theta, x) => linearImpl.predict(theta, x),
    trainBatch: (episodes, thetaPrev, options) =>
      linearImpl.trainBatch(episodes, thetaPrev, { ...config, ...options }),
    evaluatePolicy: (theta, heldOut, thetaPrev) =>
      linearImpl.evaluatePolicy(theta, heldOut, thetaPrev),
    savePolicy: (theta, metrics, options) =>
      linearImpl.savePolicy(theta, metrics, options),
    snapshot: (theta, id, policyPath) =>
      linearImpl.snapshot(theta, id, policyPath),
    loadPolicy: (policyPath) => linearImpl.loadPolicy(policyPath),
    createUpdater: (updaterOptions) =>
      linearImpl.createPolicyUpdater({ config, ...updaterOptions }),
  });
}

/**
 * Wrap the v3.6 MLP neural-policy module into the factory interface.
 * Loaded lazily so the linear path stays dependency-free when mlp is unused.
 * If `neural-policy.js` is not yet present (NL1 parallel work), fall back to
 * linear with a warning so the factory remains importable.
 *
 * @param {object} [config]
 * @param {{ warn?: Function }} [logger]
 * @returns {Promise<object>}
 */
async function createMlpAdapter(config = {}, logger = NULL_LOGGER) {
  let mlpImpl;
  try {
    mlpImpl = await import('./neural-policy.js');
  } catch (err) {
    if (typeof logger.warn === 'function') {
      logger.warn(
        `policy-factory: neural-policy.js unavailable (${err?.message ?? err}); using linear`,
      );
    }
    return createLinearAdapter(config);
  }

  return Object.freeze({
    type: 'mlp',
    modelType: 'mlp',
    config,
    predict: (model, x) => mlpImpl.predict(model, x),
    trainBatch: (episodes, prevModel, options) =>
      mlpImpl.trainBatch(episodes, prevModel, { ...config, ...options }),
    evaluatePolicy: (model, heldOut, prevModel) =>
      mlpImpl.evaluatePolicy(model, heldOut, prevModel),
    savePolicy: (model, metrics, options) =>
      mlpImpl.savePolicy(model, metrics, options),
    snapshot: (model, id, policyPath) =>
      mlpImpl.snapshot(model, id, policyPath),
    loadPolicy: (policyPath) => mlpImpl.loadPolicy(policyPath),
    createUpdater: (updaterOptions) =>
      typeof mlpImpl.createPolicyUpdater === 'function'
        ? mlpImpl.createPolicyUpdater({ config, ...updaterOptions })
        : null,
  });
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a policy instance.
 *
 * @param {object} [params]
 * @param {string} [params.type]   - 'linear' | 'mlp' (case-insensitive)
 * @param {object} [params.config] - routing config block (learning.grpoRouting.*)
 * @param {{ info?: Function, warn?: Function, error?: Function }} [params.logger]
 * @returns {Promise<object>} policy adapter with common interface
 */
export async function createPolicy(params = {}) {
  const logger = params.logger ?? NULL_LOGGER;
  const config = params.config ?? {};

  // Precedence: explicit type > config.modelType > default.
  const requested = params.type ?? config.modelType ?? DEFAULT_TYPE;
  const resolved = resolvePolicyType(requested, logger);

  if (resolved === 'mlp') {
    return createMlpAdapter(config, logger);
  }
  return createLinearAdapter(config);
}

/**
 * Create a policy by loading an existing policy file and honoring its
 * `modelType` field. Missing / malformed files fall back to `fallbackType`
 * (or factory default). Safe to call for cold-start scenarios.
 *
 * @param {object} [params]
 * @param {string} [params.policyPath]
 * @param {string} [params.fallbackType]
 * @param {object} [params.config]
 * @param {{ info?: Function, warn?: Function, error?: Function }} [params.logger]
 * @returns {Promise<{ adapter: object, policy: object|null, modelType: string }>}
 */
export async function createPolicyFromFile(params = {}) {
  const logger = params.logger ?? NULL_LOGGER;
  const config = params.config ?? {};
  const fallback = resolvePolicyType(
    params.fallbackType ?? config.modelType ?? DEFAULT_TYPE,
    logger,
  );

  let policy = null;
  try {
    policy = await linearImpl.loadPolicy(params.policyPath);
  } catch (err) {
    if (typeof logger.warn === 'function') {
      logger.warn(`policy-factory: loadPolicy failed (${err?.message ?? err})`);
    }
  }

  // Legacy files without modelType => linear.
  const rawType = policy?.modelType;
  const detectedType = rawType && rawType !== 'logistic-regression'
    ? rawType
    : (rawType === 'logistic-regression' ? 'linear' : fallback);

  const resolved = resolvePolicyType(detectedType, logger);
  const adapter = await createPolicy({ type: resolved, config, logger });

  return { adapter, policy, modelType: resolved };
}
