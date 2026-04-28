/**
 * SessionStart upgrade-check middleware.
 *
 * On the first session after a plugin version bump, compares the config
 * version against the persisted `migration-state.json` and — if they differ —
 * dispatches to the migration-runner. The middleware is idempotent within a
 * single process (module-scoped `hasRun` guard) and across sessions (the
 * migration-runner itself is idempotent by version).
 *
 * If the migration fails, the middleware records a *runtime-only* override
 * on `state.context.runtimeOverrides.learning.hierarchicalMemory.enabled = false`
 * so downstream middleware (memory, dispatch) can honour the rollback without
 * the on-disk config being rewritten.
 *
 * @module lib/runtime/middleware/upgrade-check
 */

const MODULE_STATE = { hasRunForVersion: null };

/**
 * @typedef {object} UpgradeCheckOptions
 * @property {object} config - the full artibot.config.json shape
 * @property {(opts: object) => Promise<object>} migrationRunner - from `createMigrationRunner()`
 * @property {(msg: string) => void} [logger]
 * @property {(msg: string) => void} [errorLogger]
 * @property {() => number} [now]
 * @property {boolean} [forceRerun] - testing hook; bypasses the process-local guard
 */

/**
 * Factory for the SessionStart upgrade-check middleware.
 *
 * @param {UpgradeCheckOptions} options
 * @returns {(state: object) => Promise<object>}
 */
export function createUpgradeCheckMiddleware(options = {}) {
  const {
    config,
    migrationRunner,
    logger = () => {},
    errorLogger = () => {},
    forceRerun = false,
  } = options;

  if (!config || typeof config !== 'object') {
    throw new Error('createUpgradeCheckMiddleware: config required');
  }
  if (typeof migrationRunner !== 'function') {
    throw new Error('createUpgradeCheckMiddleware: migrationRunner required');
  }

  return async function upgradeCheckMiddleware(state) {
    const targetVersion = typeof config.version === 'string' ? config.version : null;
    const userScope = config.learning?.memoryScopes?.user;
    const hierarchicalEnabled = config.learning?.hierarchicalMemory?.enabled !== false;

    if (!targetVersion || !userScope) {
      // Nothing we can reason about — leave state untouched.
      return state;
    }

    // Process-local guard: run at most once per (process, version) unless
    // forceRerun is set for tests.
    if (!forceRerun && MODULE_STATE.hasRunForVersion === targetVersion) {
      return state;
    }

    let result;
    try {
      result = await migrationRunner({
        targetVersion,
        userScope,
        hierarchicalEnabled,
        logger,
        errorLogger,
      });
    } catch (err) {
      errorLogger(`upgrade-check: migration runner crashed — ${err?.message ?? err}`);
      applyRollback(state, String(err?.message ?? err));
      MODULE_STATE.hasRunForVersion = targetVersion;
      return state;
    }

    MODULE_STATE.hasRunForVersion = targetVersion;

    state.context = state.context || {};
    state.context.upgradeCheck = {
      ran: true,
      status: result.status,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      rollback: Boolean(result.rollback),
      error: result.error ?? null,
    };

    if (Array.isArray(state.messageParts)) {
      state.messageParts.push(`upgrade-check=${result.status}`);
    }

    if (result.rollback) {
      applyRollback(state, result.error ?? 'migration failed');
    }

    return state;
  };
}

/**
 * Record a runtime-only override that disables hierarchical memory for the
 * remainder of the session. The on-disk config file is never touched.
 * @param {object} state
 * @param {string} reason
 */
function applyRollback(state, reason) {
  state.context = state.context || {};
  const existing = state.context.runtimeOverrides || {};
  const learning = existing.learning || {};
  const hierarchical = learning.hierarchicalMemory || {};

  state.context.runtimeOverrides = {
    ...existing,
    learning: {
      ...learning,
      hierarchicalMemory: {
        ...hierarchical,
        enabled: false,
        rollbackReason: reason,
      },
    },
  };
}

/**
 * Test-only helper — reset the process-local guard between cases.
 */
export function __resetUpgradeCheckState() {
  MODULE_STATE.hasRunForVersion = null;
}
