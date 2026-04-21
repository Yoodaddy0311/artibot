/**
 * Self-Control Gates — shared gate resolver for AGO cron runners.
 *
 * Every self-control runner (auto-commit, auto-cleanup, auto-pr, future
 * modules) shares an identical 4-gate sequence before any mutating action:
 *
 *   1. Opt-out: `ago.selfControl.masterEnabled === false` or
 *      `ago.selfControl.<feature>.enabled === false` blocks the run.
 *      Default/missing = ON.
 *   2. Kill switch: 3 critical failures in the configured window auto-trip
 *      the feature (per-feature) or globally (emergency mode). Tripped =
 *      refuse to run.
 *   3. First-run guard: first N runs are observe-only; the runner must log
 *      `would-*` decisions without mutating anything.
 *   4. (Per-runner critical blockers — risk ceiling, category allow-list,
 *      autoMerge rejection — are resolved by each runner individually since
 *      they are feature-specific.)
 *
 * This module centralizes gates 1-3 and the `recordFailure` side of the
 * kill-switch, so runners stay short and cannot drift out of sync.
 *
 * The module is defensive: when `lib/learning/kill-switch.js` or
 * `lib/learning/first-run-guard.js` are missing (parallel work in
 * progress), inert stubs are used. This mirrors the prior inline loaders.
 *
 * @module lib/learning/self-control-gates
 */

/**
 * @typedef {object} GateResult
 * @property {boolean} proceed - false when any gate blocks mutation
 * @property {string}  [reason] - machine-readable gate reason
 * @property {boolean} observeOnly - true when first-run guard is observe
 * @property {string}  [mode] - first-run mode ('observe' | 'active')
 * @property {number}  [runsRemaining] - remaining observe budget
 */

/**
 * Lazily import the kill-switch module. Returns inert stubs if missing or
 * broken (never throws).
 *
 * @returns {Promise<{isKillSwitchTripped: Function, recordFailure: Function}>}
 */
async function loadKillSwitch() {
  try {
    const mod = await import('./kill-switch.js');
    return {
      isKillSwitchTripped: mod.isKillSwitchTripped || (async () => false),
      recordFailure: mod.recordFailure || (async () => undefined),
    };
  } catch {
    return {
      isKillSwitchTripped: async () => false,
      recordFailure: async () => undefined,
    };
  }
}

/**
 * Lazily import the first-run-guard module. Returns inert stubs if missing.
 *
 * @returns {Promise<{shouldObserveOnly: Function, bumpRunCounter: Function}>}
 */
async function loadFirstRunGuard() {
  try {
    const mod = await import('./first-run-guard.js');
    return {
      shouldObserveOnly: mod.shouldObserveOnly ||
        (async () => ({ shouldObserve: false, mode: 'active', runsRemaining: 0 })),
      bumpRunCounter: mod.bumpRunCounter || (async () => undefined),
    };
  } catch {
    return {
      shouldObserveOnly: async () => ({ shouldObserve: false, mode: 'active', runsRemaining: 0 }),
      bumpRunCounter: async () => undefined,
    };
  }
}

/**
 * Resolve the explicit opt-out gate for a feature. Shared across runners.
 *
 * `configKey` lets callers whose feature key ID (e.g. `'auto-pr'`) differs
 * from the config-shape key (`autoPR`) look up the right slot.
 *
 * @param {string} featureName - logical feature ID (e.g. 'autoCommit', 'auto-pr')
 * @param {object} [config]
 * @param {string} [configKey] - key under `ago.selfControl` to read opt-out from; defaults to `featureName`
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkOptOut(featureName, config, configKey) {
  const sc = config?.ago?.selfControl;
  if (sc?.masterEnabled === false) {
    return { allowed: false, reason: 'masterEnabled=false' };
  }
  const key = configKey || featureName;
  if (sc?.[key]?.enabled === false) {
    return { allowed: false, reason: `${key}.enabled=false` };
  }
  return { allowed: true };
}

/**
 * Resolve all self-control gates for a single run.
 *
 * Side effects:
 *   - Bumps the first-run counter when the guard is active (observe or not),
 *     so the counter progresses exactly once per call. Runners MUST NOT call
 *     `bumpRunCounter` themselves when using this helper.
 *   - No git, no network, no config mutation.
 *
 * @param {string} featureName
 * @param {object} config
 * @param {object} [opts]
 * @param {string} [opts.pluginRoot]
 * @param {string} [opts.configKey] - alt config key when feature id differs from config shape
 * @param {object} [opts.killSwitch] - injected for tests
 * @param {object} [opts.firstRunGuard] - injected for tests
 * @returns {Promise<GateResult>}
 */
export async function resolveSelfControlGates(featureName, config, opts = {}) {
  if (!featureName || typeof featureName !== 'string') {
    throw new TypeError('resolveSelfControlGates: featureName required');
  }

  const optOut = checkOptOut(featureName, config, opts.configKey);
  if (!optOut.allowed) {
    return { proceed: false, reason: optOut.reason, observeOnly: false };
  }

  // When callers inject mocks (tests), prefer the 2-arg call shape they assert
  // on. Lazy-loaded (production) calls pass `pluginRoot` through so path
  // resolution works under alt-roots.
  const hasInjectedKS = Boolean(opts.killSwitch);
  const ks = opts.killSwitch || (await loadKillSwitch());
  const killed = hasInjectedKS
    ? await ks.isKillSwitchTripped(config)
    : await ks.isKillSwitchTripped(config, { pluginRoot: opts.pluginRoot, feature: featureName });
  if (killed) {
    return { proceed: false, reason: 'kill-switch tripped', observeOnly: false };
  }

  const hasInjectedFRG = Boolean(opts.firstRunGuard);
  const frg = opts.firstRunGuard || (await loadFirstRunGuard());
  const obs = hasInjectedFRG
    ? await frg.shouldObserveOnly(featureName, config)
    : await frg.shouldObserveOnly(featureName, config, { pluginRoot: opts.pluginRoot });
  if (hasInjectedFRG) {
    await frg.bumpRunCounter(featureName, config);
  } else {
    await frg.bumpRunCounter(featureName, config, { pluginRoot: opts.pluginRoot });
  }

  if (obs?.shouldObserve) {
    return {
      proceed: true,
      observeOnly: true,
      mode: obs.mode || 'observe',
      runsRemaining: obs.runsRemaining ?? 0,
    };
  }
  return { proceed: true, observeOnly: false, mode: 'active', runsRemaining: 0 };
}

/**
 * Report a critical failure for a feature to the kill-switch (best-effort).
 * Swallows all errors — never let telemetry failures bubble into runners.
 *
 * @param {string} featureName
 * @param {Error|string} error
 * @param {object} [config]
 * @param {{pluginRoot?: string, killSwitch?: object}} [opts] - inject `killSwitch` for tests
 * @returns {Promise<void>}
 */
export async function reportCriticalFailure(featureName, error, config, opts = {}) {
  if (!featureName) return;
  const message = error instanceof Error
    ? error.message
    : (typeof error === 'string' ? error : String(error));
  try {
    const hasInjectedKS = Boolean(opts.killSwitch);
    const ks = opts.killSwitch || (await loadKillSwitch());
    if (hasInjectedKS) {
      await ks.recordFailure({ feature: featureName, error: message }, config);
    } else {
      await ks.recordFailure(
        { feature: featureName, error: message },
        config,
        { pluginRoot: opts.pluginRoot },
      );
    }
  } catch { /* best-effort */ }
}

/** @internal — exposed for tests */
export const _internals = { loadKillSwitch, loadFirstRunGuard };
