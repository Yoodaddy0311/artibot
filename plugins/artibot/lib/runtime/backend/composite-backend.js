/**
 * Lightweight composite backend selector for Phase 1 runtime.
 * This is intentionally minimal and hook-friendly.
 *
 * @module lib/runtime/backend/composite-backend
 */

const DEFAULT_BACKENDS = Object.freeze({
  local: {
    id: 'local',
    label: 'Local shell + filesystem',
    capabilities: ['shell', 'filesystem'],
  },
  remote: {
    id: 'remote',
    label: 'Remote sandbox',
    capabilities: ['sandbox', 'isolated-execution'],
  },
});

/**
 * Create a backend selector that chooses local/remote execution mode.
 * @param {object} [options]
 * @param {boolean} [options.preferRemoteForComplex=true] - Route complex tasks to remote backend.
 * @param {Record<string, object>} [options.backends] - Optional backend override map.
 * @returns {{
 *   name: string,
 *   backends: Record<string, object>,
 *   selectBackend: (runtimeContext?: object) => object,
 *   describe: () => { active: string[], strategy: string }
 * }}
 */
export function createCompositeBackend(options = {}) {
  const {
    preferRemoteForComplex = true,
    backends: backendOverrides = {},
  } = options;

  const backends = {
    ...DEFAULT_BACKENDS,
    ...backendOverrides,
  };

  /**
   * Select backend from runtime context.
   * @param {object} [runtimeContext]
   * @returns {object}
   */
  function selectBackend(runtimeContext = {}) {
    const system = runtimeContext?.routing?.system;
    const shouldUseRemote = preferRemoteForComplex && system === 'system2' && backends.remote;
    if (shouldUseRemote) return backends.remote;
    return backends.local || Object.values(backends)[0];
  }

  return {
    name: 'composite-backend',
    backends,
    selectBackend,
    describe() {
      return {
        active: Object.keys(backends),
        strategy: preferRemoteForComplex ? 'complex->remote, otherwise->local' : 'always-local-first',
      };
    },
  };
}

